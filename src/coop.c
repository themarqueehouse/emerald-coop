#include "global.h"
#include "coop.h"
#include "link.h"
#include "net_link.h"
#include "task.h"
#include "overworld.h"
#include "event_object_movement.h"
#include "field_player_avatar.h"
#include "constants/event_objects.h"

// ---------------------------------------------------------------------------
// Co-op session state machine. See include/coop.h for why this exists rather
// than reusing the game's own link-room machinery.
// ---------------------------------------------------------------------------

EWRAM_DATA struct CoopPeer gCoopPeer = {0};
static EWRAM_DATA u8 sCoopState = 0;
static EWRAM_DATA u16 sStateTimer = 0;

// The player data exchange normally gets 600 frames (10s) before the cable
// code calls it a timeout. The relay has already told us both players are
// present, so a stall here means something is wrong rather than merely slow;
// still, be generous enough to survive a bad moment on mobile data.
#define EXCHANGE_TIMEOUT_FRAMES 900

// How long without hearing from the peer before we treat them as gone. The
// transport delivers nothing at all when a frame is missing, so silence is the
// only signal available.
#define PEER_SILENCE_FRAMES 300 // 5 seconds

bool8 IsCoopLinkActive(void)
{
    return sCoopState == COOP_STATE_ACTIVE;
}

bool8 IsCoopSessionPaired(void)
{
    return gNetLinkActive && NetLink_GetHostStatus() == NET_HOST_READY
        && NetLink_GetPlayerCount() == NET_MAX_PLAYERS;
}

u8 GetCoopState(void)
{
    return sCoopState;
}

void Coop_Reset(void)
{
    sCoopState = COOP_STATE_OFF;
    sStateTimer = 0;
    gCoopPeer.valid = FALSE;
}

static void EnterState(u8 state)
{
    sCoopState = state;
    sStateTimer = 0;
}

void Coop_Update(void)
{
    // Nothing to do unless the wrapper is present. A plain emulator leaves the
    // mailbox untouched and we stay dormant, which is what makes the same ROM
    // still playable single-player.
    if (!gNetLinkActive)
    {
        if (sCoopState != COOP_STATE_OFF)
            Coop_Reset();
        return;
    }

    if (sStateTimer < 0xFFFF)
        sStateTimer++;

    switch (sCoopState)
    {
    case COOP_STATE_OFF:
        if (!IsCoopSessionPaired())
            break;

        // Both sides must agree on gLinkType before the exchange, or
        // GetLinkPlayerDataExchangeStatusTimed reports EXCHANGE_DIFF_SELECTIONS
        // and tears the link down. Both ROMs reach here by the same path, so
        // they always agree.
        gLinkType = LINKTYPE_COOP;
        OpenLink();
        EnterState(COOP_STATE_OPENING);
        break;

    case COOP_STATE_OPENING:
        if (!IsCoopSessionPaired())
        {
            EnterState(COOP_STATE_LOST);
            break;
        }
        // OpenLink spawns Task_TriggerHandshake, which pokes the state machine
        // five frames later. Once the transport reports a connection we move on
        // and wait for the player blocks to arrive.
        if (gLinkStatus & LINK_STAT_CONN_ESTABLISHED)
            EnterState(COOP_STATE_EXCHANGING);
        break;

    case COOP_STATE_EXCHANGING:
        if (!IsCoopSessionPaired())
        {
            EnterState(COOP_STATE_LOST);
            break;
        }
        // gReceivedRemoteLinkPlayers is the game's own "this link is usable"
        // flag. Nothing may be sent before it is set.
        if (gReceivedRemoteLinkPlayers == 1)
        {
            gCoopPeer.valid = FALSE;
            EnterState(COOP_STATE_ACTIVE);
            break;
        }
        if (sStateTimer > EXCHANGE_TIMEOUT_FRAMES)
        {
            // Give up rather than sit here forever; the next pass will retry
            // from OFF if both players are still present.
            CloseLink();
            EnterState(COOP_STATE_OFF);
        }
        break;

    case COOP_STATE_ACTIVE:
        if (!IsCoopSessionPaired() || !gReceivedRemoteLinkPlayers)
        {
            EnterState(COOP_STATE_LOST);
            break;
        }
        break;

    case COOP_STATE_LOST:
        // Hold here until the relay reports both players again, then rebuild
        // the link from scratch. Reconnecting into a half-open link is how
        // stale commands get replayed as live input.
        if (IsCoopSessionPaired())
        {
            CloseLink();
            Coop_Reset();
        }
        break;
    }
}
