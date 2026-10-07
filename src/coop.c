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

static void CoopSendPositionCB(void);

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
        // Re-arm rather than set once. InitBlockSend overwrites gLinkCallback
        // outright, so any trade or battle setup silently evicts us and never
        // puts us back; checking for NULL each frame heals that automatically.
        if (gLinkCallback == NULL)
            gLinkCallback = CoopSendPositionCB;
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

// ---------------------------------------------------------------------------
// Position broadcast
//
// One command per frame, 7 u16 words of payload. We send where we are rather
// than which buttons we pressed, so each console runs its own game with every
// movement system intact. Coordinates travel in camera space (map coords plus
// MAP_OFFSET), which is what both gObjectEvents and the spawn helper use, so
// nothing has to be converted on either side.
// ---------------------------------------------------------------------------

// Local id for the partner's object event. Map-authored NPCs use small ids, so
// this sits well clear of them.
#define COOP_PEER_LOCAL_ID 0xF0

// Object-event slot the partner currently occupies, or OBJECT_EVENTS_COUNT.
static EWRAM_DATA u8 sPeerObjectId = 0;
static EWRAM_DATA u16 sFrameCounter = 0;

/**
 * Map the local player's avatar flags to the state id the graphics tables use.
 *
 * The flags are a bitfield that can hold several bits at once (CONTROLLABLE
 * and DASH ride alongside the real state), so order matters: check the most
 * specific first. Underwater before surfing, because underwater sets both.
 */
static u8 GetPlayerAvatarStateForCoop(void)
{
    u8 flags = gPlayerAvatar.flags;

    if (flags & PLAYER_AVATAR_FLAG_UNDERWATER)
        return PLAYER_AVATAR_STATE_UNDERWATER;
    if (flags & PLAYER_AVATAR_FLAG_SURFING)
        return PLAYER_AVATAR_STATE_SURFING;
    if (flags & PLAYER_AVATAR_FLAG_MACH_BIKE)
        return PLAYER_AVATAR_STATE_MACH_BIKE;
    if (flags & PLAYER_AVATAR_FLAG_ACRO_BIKE)
        return PLAYER_AVATAR_STATE_ACRO_BIKE;

    return PLAYER_AVATAR_STATE_NORMAL;
}

static void CoopSendPositionCB(void)
{
    struct ObjectEvent *me;

    if (gReceivedRemoteLinkPlayers != TRUE)
        return;

    me = &gObjectEvents[gPlayerAvatar.objectEventId];

    gSendCmd[0] = LINKCMD_COOP_POS;
    gSendCmd[1] = gSaveBlock1Ptr->location.mapGroup
                | ((u16)gSaveBlock1Ptr->location.mapNum << 8);
    gSendCmd[2] = me->currentCoords.x;
    gSendCmd[3] = me->currentCoords.y;
    gSendCmd[4] = (me->facingDirection & 0xF)
                | ((me->currentElevation & 0xF) << 4)
                | ((GetPlayerAvatarStateForCoop() & 0xF) << 8)
                | ((gSaveBlock2Ptr->playerGender & 0x1) << 12);
    // Whether we are mid-step. The receiver uses it to decide between a walk
    // animation and standing still, which is what stops a partner who is
    // simply standing there from twitching.
    gSendCmd[5] = (me->heldMovementActive && !me->heldMovementFinished) ? 1 : 0;
}

void Coop_ReceivePosition(u8 playerId, const u16 *cmd)
{
    // Our own broadcast is looped back to us by the transport, exactly as the
    // cable did. Ignore it; we are not our own partner.
    if (playerId == GetMultiplayerId())
        return;

    gCoopPeer.mapGroup = cmd[1] & 0xFF;
    gCoopPeer.mapNum = (cmd[1] >> 8) & 0xFF;
    gCoopPeer.x = cmd[2];
    gCoopPeer.y = cmd[3];
    gCoopPeer.facing = cmd[4] & 0xF;
    gCoopPeer.elevation = (cmd[4] >> 4) & 0xF;
    gCoopPeer.avatarState = (cmd[4] >> 8) & 0xF;
    gCoopPeer.gender = (cmd[4] >> 12) & 0x1;
    gCoopPeer.moving = cmd[5] & 1;
    gCoopPeer.lastSeenFrame = sFrameCounter;
    gCoopPeer.valid = TRUE;
}

static bool8 PeerIsOnOurMap(void)
{
    return gCoopPeer.valid
        && gCoopPeer.mapGroup == gSaveBlock1Ptr->location.mapGroup
        && gCoopPeer.mapNum == gSaveBlock1Ptr->location.mapNum;
}

static bool8 PeerHasGoneQuiet(void)
{
    return (u16)(sFrameCounter - gCoopPeer.lastSeenFrame) > PEER_SILENCE_FRAMES;
}

static struct ObjectEvent *GetPeerObject(void)
{
    struct ObjectEvent *obj;

    if (sPeerObjectId >= OBJECT_EVENTS_COUNT)
        return NULL;

    obj = &gObjectEvents[sPeerObjectId];

    // A map change resets every object event, so the slot we remember may now
    // be inactive or reused by an NPC. Verify rather than trust it.
    if (!obj->active || obj->localId != COOP_PEER_LOCAL_ID)
    {
        sPeerObjectId = OBJECT_EVENTS_COUNT;
        return NULL;
    }

    return obj;
}

static void DespawnPeer(void)
{
    if (GetPeerObject() != NULL)
    {
        RemoveObjectEventByLocalIdAndMap(COOP_PEER_LOCAL_ID,
                                         gSaveBlock1Ptr->location.mapNum,
                                         gSaveBlock1Ptr->location.mapGroup);
    }
    sPeerObjectId = OBJECT_EVENTS_COUNT;
}

static void SpawnPeer(void)
{
    u16 gfxId = GetRivalAvatarGraphicsIdByStateIdAndGender(gCoopPeer.avatarState,
                                                           gCoopPeer.gender);
    u8 id = SpawnSpecialObjectEventParameterized(gfxId, MOVEMENT_TYPE_NONE,
                                                 COOP_PEER_LOCAL_ID,
                                                 gCoopPeer.x, gCoopPeer.y,
                                                 gCoopPeer.elevation);

    // Returns OBJECT_EVENTS_COUNT when all 16 slots are taken. A busy route can
    // genuinely run out; try again next frame rather than treating it as fatal.
    if (id >= OBJECT_EVENTS_COUNT)
    {
        sPeerObjectId = OBJECT_EVENTS_COUNT;
        return;
    }

    sPeerObjectId = id;
    ObjectEventTurn(&gObjectEvents[id], gCoopPeer.facing);
}

void Coop_UpdatePeerSprite(void)
{
    struct ObjectEvent *peer;
    s16 dx, dy;

    sFrameCounter++;

    if (!IsCoopLinkActive() || !PeerIsOnOurMap() || PeerHasGoneQuiet())
    {
        DespawnPeer();
        return;
    }

    peer = GetPeerObject();
    if (peer == NULL)
    {
        SpawnPeer();
        return;
    }

    // Swap the sprite when they get on a bike, surf, and so on. Cheap to call
    // every frame -- it returns immediately when the id is unchanged.
    ObjectEventSetGraphicsId(peer,
        GetRivalAvatarGraphicsIdByStateIdAndGender(gCoopPeer.avatarState,
                                                   gCoopPeer.gender));

    // Let any walk already in progress finish before starting another, or the
    // sprite stutters in place instead of sliding between tiles.
    if (ObjectEventClearHeldMovementIfFinished(peer) == 0
        && peer->heldMovementActive)
        return;

    dx = (s16)gCoopPeer.x - peer->currentCoords.x;
    dy = (s16)gCoopPeer.y - peer->currentCoords.y;

    if (dx == 0 && dy == 0)
    {
        if (peer->facingDirection != gCoopPeer.facing)
            ObjectEventTurn(peer, gCoopPeer.facing);
        return;
    }

    // Exactly one tile in a cardinal direction: animate the step, so the
    // partner slides naturally and triggers grass rustle, reflections and the
    // rest of the ground effects for free.
    if ((dx == 0 && (dy == 1 || dy == -1)) || (dy == 0 && (dx == 1 || dx == -1)))
    {
        u8 dir = dx == 1 ? DIR_EAST : dx == -1 ? DIR_WEST
               : dy == 1 ? DIR_SOUTH : DIR_NORTH;

        ObjectEventSetHeldMovement(peer, GetWalkNormalMovementAction(dir));
        return;
    }

    // Anything else is a warp, a ledge hop, or us having missed frames. Snap
    // rather than trying to animate a path we never saw them take.
    MoveObjectEventToMapCoords(peer, gCoopPeer.x, gCoopPeer.y);
    ObjectEventTurn(peer, gCoopPeer.facing);
}
