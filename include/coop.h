#ifndef GUARD_COOP_H
#define GUARD_COOP_H

#include "global.h"

// ---------------------------------------------------------------------------
// Co-op session: a link that stays up during ordinary overworld play.
//
// The game's own link rooms (Trade Center, Colosseum) hold a link open too,
// but they do it by replacing CB1_Overworld with CB1_OverworldLink, which
// swaps the whole player-movement system for a cut-down one that can only
// walk. That is why those rooms have no running, bikes, surfing or ledges --
// nobody needed them in a trade room.
//
// Co-op keeps CB1_Overworld, so both players run the real game with every
// movement system intact, and we send each other our positions instead of our
// button presses. Keeping CB1_Overworld also means IsOverworldLinkActive()
// stays FALSE, which is what preserves the normal Start menu, the Save option,
// and script lock/lockall.
// ---------------------------------------------------------------------------

enum CoopState
{
    // No co-op. Either the host is not a co-op wrapper at all, or the second
    // player has not joined yet.
    COOP_STATE_OFF,
    // Both players present; bringing the link up.
    COOP_STATE_OPENING,
    // Link open, waiting for the player data exchange to complete. Until it
    // does, gReceivedRemoteLinkPlayers is clear and nothing may be sent.
    COOP_STATE_EXCHANGING,
    // Running: positions are being broadcast every frame.
    COOP_STATE_ACTIVE,
    // The peer went away. Distinct from OFF so the game can say so.
    COOP_STATE_LOST,
};

// What one player broadcasts about itself, once per frame.
struct CoopPeer
{
    bool8 valid;        // have we ever received anything from them
    u8 mapGroup;
    u8 mapNum;
    u8 facing;          // DIR_*
    u16 x;              // map coords, MAP_OFFSET already applied
    u16 y;
    u8 elevation;
    u8 avatarState;     // PLAYER_AVATAR_STATE_* -- walking, biking, surfing...
    u8 gender;
    bool8 moving;       // mid-step, so the sprite should animate rather than idle
    u16 lastSeenFrame;  // for noticing a peer that has gone quiet
};

extern struct CoopPeer gCoopPeer;

/**
 * True while a co-op session is running.
 *
 * Deliberately NOT the same question as "is a link active". Co-op is a link,
 * but it is not the kind of link that menus like the bag mean when they ask --
 * those are asking "am I in a trade room, where items must be restricted".
 * Everyday play must stay fully available during co-op, so anything gating on
 * gReceivedRemoteLinkPlayers needs to exclude this case explicitly.
 */
bool8 IsCoopLinkActive(void);

/** True once both players are present, whether or not the link is up yet. */
bool8 IsCoopSessionPaired(void);

u8 GetCoopState(void);

/** Called once per frame from the overworld. Drives the state machine. */
void Coop_Update(void);

/** Reset everything; used when a session ends or the peer is lost. */
void Coop_Reset(void);

#endif // GUARD_COOP_H
