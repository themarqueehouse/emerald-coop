#include "global.h"
#include "link.h"
#include "net_link.h"

// ---------------------------------------------------------------------------
// Co-op network transport. See include/net_link.h for the shape of the seam.
//
// Two behaviours of the cable transport are load-bearing and reproduced here
// exactly; getting either wrong desyncs the game in ways that look random:
//
//  1. An all-zero send command is NOT transmitted. The game writes gSendCmd
//     every frame but it is zero on most of them, and the cable code only
//     advances its queue when at least one word was nonzero (sSendNonzeroCheck
//     in EnqueueSendCmd). If we relayed the zeros, every state machine above us
//     that counts commands would run fast.
//
//  2. Receives are atomic across players. One cable queue slot held every
//     player's command for the same link frame, and DequeueRecvCmds popped the
//     whole row or nothing. So we only deliver when BOTH players have a frame
//     waiting; otherwise we deliver nothing and raise receivedNothing. This is
//     the lockstep discipline - it is what makes a socket behave like a cable.
// ---------------------------------------------------------------------------

EWRAM_DATA struct NetMailbox gNetMailbox = {0};
EWRAM_DATA bool8 gNetLinkActive = FALSE;

// Mirrors gLink.state so the status word we synthesize follows the same
// progression the game expects from the cable path.
static EWRAM_DATA u8 sNetState = 0;
static EWRAM_DATA u8 sNetQueueFull = 0;
static EWRAM_DATA bool8 sNetReceivedNothing = FALSE;

static bool8 RingHasData(u8 head, u8 tail)
{
    return head != tail;
}

static u8 RingCount(u8 head, u8 tail)
{
    return (u8)((head - tail) & NET_RING_MASK);
}

void NetLink_Init(void)
{
    u32 i;
    u8 *p = (u8 *)&gNetMailbox;

    for (i = 0; i < sizeof(gNetMailbox); i++)
        p[i] = 0;

    // Written last: the host polls for the magic to locate us, and must not
    // see a half-initialized mailbox.
    gNetMailbox.version = NET_PROTOCOL_VERSION;
    gNetMailbox.magic = NET_MAILBOX_MAGIC;

    sNetState = LINK_STATE_START0;
    sNetQueueFull = QUEUE_FULL_NONE;
    sNetReceivedNothing = FALSE;
    gNetLinkActive = FALSE;
}

void NetLink_Reset(void)
{
    gNetMailbox.outHead = 0;
    gNetMailbox.outTail = 0;
    gNetMailbox.inHead[0] = 0;
    gNetMailbox.inHead[1] = 0;
    gNetMailbox.inTail[0] = 0;
    gNetMailbox.inTail[1] = 0;
    sNetState = LINK_STATE_START0;
    sNetQueueFull = QUEUE_FULL_NONE;
    sNetReceivedNothing = FALSE;
}

u8 NetLink_GetHostStatus(void)
{
    if (gNetMailbox.magic != NET_MAILBOX_MAGIC)
        return NET_HOST_DOWN;

    return gNetMailbox.hostStatus;
}

// A plain emulator never touches the mailbox, so hostStatus stays DOWN and we
// report no co-op support. Once the wrapper has moved us off DOWN even once we
// latch gNetLinkActive, so a later dropout reads as "partner lost" rather than
// silently falling back to the cable path mid-session.
bool8 NetLink_HostSupportsCoop(void)
{
    u8 status = NetLink_GetHostStatus();

    if (status != NET_HOST_DOWN)
        gNetLinkActive = TRUE;

    return gNetLinkActive;
}

u8 NetLink_GetMultiplayerId(void)
{
    u8 id = gNetMailbox.localId;

    if (id >= NET_MAX_PLAYERS)
        return 0;

    return id;
}

u8 NetLink_GetPlayerCount(void)
{
    u8 count = gNetMailbox.playerCount;

    if (count > NET_MAX_PLAYERS)
        return NET_MAX_PLAYERS;

    return count;
}

bool8 NetLink_IsMaster(void)
{
    return NetLink_GetMultiplayerId() == 0;
}

u32 NetLink_GetSendQueueLength(void)
{
    return RingCount(gNetMailbox.outHead, gNetMailbox.outTail);
}

// The game throttles the overworld on this (OVERWORLD_RECV_QUEUE_MAX), so it
// must reflect the shallowest player ring - the one holding everyone up.
u32 NetLink_GetRecvQueueLength(void)
{
    u8 count = NetLink_GetPlayerCount();
    u32 shallowest = NET_RING_SLOTS;
    u8 i;

    if (count == 0)
        return 0;

    for (i = 0; i < count; i++)
    {
        u32 n = RingCount(gNetMailbox.inHead[i], gNetMailbox.inTail[i]);

        if (n < shallowest)
            shallowest = n;
    }

    return shallowest;
}

// Reproduces EnqueueSendCmd, including the drop-if-all-zero rule and the
// zeroing of the caller's buffer only when the command was accepted.
static void NetEnqueueSendCmd(u16 *sendCmd)
{
    u8 head = gNetMailbox.outHead;
    u8 tail = gNetMailbox.outTail;
    u16 nonzero = 0;
    u8 i;

    for (i = 0; i < CMD_LENGTH; i++)
        nonzero |= sendCmd[i];

    if (nonzero == 0)
        return;

    if (RingCount(head, tail) >= NET_RING_MASK)
    {
        sNetQueueFull = QUEUE_FULL_SEND;
        return;
    }

    for (i = 0; i < CMD_LENGTH; i++)
    {
        gNetMailbox.out[head & NET_RING_MASK].cmd[i] = sendCmd[i];
        sendCmd[i] = 0;
    }

    gNetMailbox.outHead = (u8)((head + 1) & NET_RING_MASK);
}

// Reproduces DequeueRecvCmds: all players or none.
static void NetDequeueRecvCmds(u16 (*recvCmds)[CMD_LENGTH])
{
    u8 count = NetLink_GetPlayerCount();
    bool8 allReady = TRUE;
    u8 i, j;

    if (count == 0)
        count = 1;

    for (i = 0; i < count; i++)
    {
        if (!RingHasData(gNetMailbox.inHead[i], gNetMailbox.inTail[i]))
            allReady = FALSE;
    }

    if (!allReady)
    {
        for (i = 0; i < count; i++)
        {
            for (j = 0; j < CMD_LENGTH; j++)
                recvCmds[i][j] = 0;
        }

        sNetReceivedNothing = TRUE;
        return;
    }

    for (i = 0; i < count; i++)
    {
        u8 tail = gNetMailbox.inTail[i];

        for (j = 0; j < CMD_LENGTH; j++)
            recvCmds[i][j] = gNetMailbox.in[i][tail & NET_RING_MASK].cmd[j];

        gNetMailbox.inTail[i] = (u8)((tail + 1) & NET_RING_MASK);
    }

    sNetReceivedNothing = FALSE;
}

u32 NetLinkMain1(u8 *shouldAdvanceLinkState, u16 *sendCmd, u16 (*recvCmds)[CMD_LENGTH])
{
    u8 status = NetLink_GetHostStatus();
    u8 localId;
    u8 playerCount;
    u32 retVal;

    // Backpressure is a condition of THIS frame, not a permanent state. The
    // cable transport gets away with latching it because gLink is re-zeroed
    // whenever the port is re-enabled; nothing re-zeroes this. Left latched,
    // a single ring overflow raises LINK_STAT_ERROR_QUEUE_FULL forever, and
    // TrySetLinkErrorBuffer turns that into CB2_LinkError within one frame --
    // so one burst of lag would permanently kill the session.
    sNetQueueFull = QUEUE_FULL_NONE;

    // The handshake is the host's job, not ours: it owns the socket and knows
    // when the peer has joined. We only mirror its verdict into the state
    // machine the game is watching.
    switch (sNetState)
    {
        case LINK_STATE_START0:
            NetLink_Reset();
            sNetState = LINK_STATE_START1;
            break;
        case LINK_STATE_START1:
            if (*shouldAdvanceLinkState == 1)
                sNetState = LINK_STATE_HANDSHAKE;
            break;
        case LINK_STATE_HANDSHAKE:
            if (*shouldAdvanceLinkState == 2)
            {
                sNetState = LINK_STATE_START0;
            }
            else if (status == NET_HOST_READY
                  && NetLink_GetPlayerCount() == NET_MAX_PLAYERS)
            {
                sNetState = LINK_STATE_CONN_ESTABLISHED;
            }
            break;
        case LINK_STATE_CONN_ESTABLISHED:
            NetEnqueueSendCmd(sendCmd);
            NetDequeueRecvCmds(recvCmds);
            break;
    }

    *shouldAdvanceLinkState = 0;

    localId = NetLink_GetMultiplayerId();
    playerCount = NetLink_GetPlayerCount();

    retVal = localId;
    retVal |= (u32)playerCount << LINK_STAT_PLAYER_COUNT_SHIFT;

    if (NetLink_IsMaster())
        retVal |= LINK_STAT_MASTER;

    if (sNetReceivedNothing)
        retVal |= 1 << LINK_STAT_RECEIVED_NOTHING_SHIFT;

    if (sNetQueueFull != QUEUE_FULL_NONE)
        retVal |= (u32)sNetQueueFull << LINK_STAT_ERROR_QUEUE_FULL_SHIFT;

    if (sNetState == LINK_STATE_CONN_ESTABLISHED)
        retVal |= LINK_STAT_CONN_ESTABLISHED;

    // A peer that vanishes mid-session surfaces as a hardware error, which is
    // the one failure the game already knows how to report and recover from.
    if (gNetLinkActive && status == NET_HOST_LOST)
        retVal |= LINK_STAT_ERROR_HARDWARE;

    if (localId >= MAX_LINK_PLAYERS)
        retVal |= LINK_STAT_ERROR_INVALID_ID;

    return retVal;
}
