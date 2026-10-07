#ifndef GUARD_NET_LINK_H
#define GUARD_NET_LINK_H

#include "global.h"
#include "link.h"

// ---------------------------------------------------------------------------
// Co-op network transport.
//
// The GBA has no network hardware, so this module does not talk to a socket.
// Instead it exposes a mailbox in EWRAM. The host (the browser wrapper that
// owns the emulator) reads the outbox and writes the inbox between frames,
// relaying over a WebSocket. From the game's point of view this replaces the
// serial-cable transport underneath LinkMain1 and nothing above it changes.
//
// Everything above the seam continues to speak only in terms of:
//     gSendCmd[CMD_LENGTH], gRecvCmds[][CMD_LENGTH], gLinkStatus,
//     gShouldAdvanceLinkState, gBlockSendBuffer, gBlockRecvBuffer
// which is why trade, link battle and the block layer work untouched.
// ---------------------------------------------------------------------------

// 'COOP' - lets the host verify it found the mailbox and not random EWRAM.
#define NET_MAILBOX_MAGIC    0x504F4F43
#define NET_PROTOCOL_VERSION 1

// This hack is strictly two players. Kept as a named constant because the
// ring arrays are sized from it, not because 3+ would work.
#define NET_MAX_PLAYERS 2

// Ring depth, in logical link commands. The game produces at most one command
// per video frame, so 8 slots is ~133ms of buffer before backpressure. Must be
// a power of two: the index arithmetic relies on the & mask.
#define NET_RING_SLOTS 8
#define NET_RING_MASK  (NET_RING_SLOTS - 1)

// Host connection status. Written by the wrapper, read by the ROM.
enum NetHostStatus
{
    // No wrapper, or the wrapper has not reached the relay yet. A plain
    // emulator with no co-op support also leaves the mailbox zeroed, which
    // lands here - that is deliberate, it is how we detect "unsupported host".
    NET_HOST_DOWN = 0,
    // Socket open, waiting for the second player to join the session.
    NET_HOST_CONNECTING,
    // Both players present. This is the only state in which the game runs.
    NET_HOST_READY,
    // We were READY and the peer dropped. Distinct from DOWN so the game can
    // say "your partner disconnected" rather than "no connection".
    NET_HOST_LOST,
};

// One logical link command: exactly what the cable transport moved per frame.
struct NetFrame
{
    u16 cmd[CMD_LENGTH];
};

// The mailbox. Single-producer/single-consumer per ring, with the two sides
// touching different cursors, so no locking is needed: the wrapper only runs
// while the CPU is halted between frames.
struct NetMailbox
{
    /*0x00*/ u32 magic;    // NET_MAILBOX_MAGIC, written by the ROM at init
    /*0x04*/ u8 version;   // NET_PROTOCOL_VERSION, written by the ROM
    /*0x05*/ volatile u8 hostStatus;  // host writes: enum NetHostStatus
    /*0x06*/ volatile u8 localId;     // host writes: which player we are, 0 or 1
    /*0x07*/ volatile u8 playerCount; // host writes: players in session

    // ROM -> host. ROM advances outHead, host advances outTail.
    /*0x08*/ volatile u8 outHead;
    /*0x09*/ volatile u8 outTail;

    // host -> ROM, one ring per player. Host advances inHead, ROM advances
    // inTail. The local player's own ring is also filled (loopback) so that
    // gRecvCmds[localId] is populated exactly as the cable transport did it.
    /*0x0A*/ volatile u8 inHead[NET_MAX_PLAYERS];
    /*0x0C*/ volatile u8 inTail[NET_MAX_PLAYERS];

    // Incremented every VBlank, unconditionally, from the moment the ROM
    // boots. Its only job is to prove which copy of this struct is the live
    // one: an emulator may hold several (rewind snapshots, save states), and
    // all of them carry a valid-looking magic word. A snapshot's heartbeat is
    // frozen; the live mailbox's ticks. Occupies what was padding, so the
    // struct size is unchanged.
    /*0x0E*/ volatile u16 heartbeat;

    /*0x10*/ struct NetFrame out[NET_RING_SLOTS];
    /*0x90*/ struct NetFrame in[NET_MAX_PLAYERS][NET_RING_SLOTS];
}; // sizeof = 0x190

extern struct NetMailbox gNetMailbox;

// True once the host has been seen to support co-op (magic survived and the
// host moved hostStatus off NET_HOST_DOWN at least once). Used to decide
// whether to take the net path or fall back to the cable path.
extern bool8 gNetLinkActive;

void NetLink_Init(void);
bool8 NetLink_HostSupportsCoop(void);
u8 NetLink_GetHostStatus(void);

// Drop-in replacement for LinkMain1. Same signature, same return contract
// (a packed gLinkStatus), same one-command-per-frame cadence.
u32 NetLinkMain1(u8 *shouldAdvanceLinkState, u16 *sendCmd, u16 (*recvCmds)[CMD_LENGTH]);

u8 NetLink_GetMultiplayerId(void);
u8 NetLink_GetPlayerCount(void);
bool8 NetLink_IsMaster(void);
u32 NetLink_GetSendQueueLength(void);
u32 NetLink_GetRecvQueueLength(void);
void NetLink_Reset(void);

#endif // GUARD_NET_LINK_H
