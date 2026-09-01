# Target Ranked-Game Architecture

## 1. The Core Change

The current architecture assumes:

```text
one player
    ↓
one ranked game
    ↓
one checkpoint queue
    ↓
completion
```

The new architecture should support:

```text
one player
    │
    ├── Game A
    │      ├── receipt
    │      ├── checkpoint queue
    │      └── pending verification
    │
    ├── Game B
    │      ├── receipt
    │      ├── checkpoint queue
    │      └── pending verification
    │
    ├── Game C
    │      ├── receipt
    │      ├── checkpoint queue
    │      └── pending verification
    │
    └── Game D
           ├── receipt
           ├── checkpoint queue
           └── active / pending / verified
```

The important idea is that **a player can have multiple ranked-game records at the same time**.

However, only **one of them may be ACTIVE**.

---

# 2. One Player, Multiple Games

The player should be able to have several games in different states:

```text
                ┌──────────────┐
                │ Game A       │
                │ PENDING      │
                │ verification │
                └──────────────┘


Player
  │
  ▼
┌──────────────┐
│ Game B       │
│ ACTIVE       │  ← only one active game
└──────────────┘


                ┌──────────────┐
                │ Game C       │
                │ PENDING      │
                │ verification │
                └──────────────┘
```

This is the key invariant:

```text
                  PLAYER
                    │
          ┌─────────┼─────────┐
          │         │         │
          ▼         ▼         ▼
       Game A    Game B    Game C
       PENDING   ACTIVE    PENDING
```

There can be many:

```text
PENDING
```

games, but only one:

```text
ACTIVE
```

game.

---

# 3. Why This Is Different From the Current Architecture

### Current architecture

The client effectively behaves as if there is only one current ranked game:

```text
games
└── current
      └── one ranked game
```

The lifecycle is:

```text
┌──────────────┐
│   Game #1    │
│    ACTIVE    │
└──────┬───────┘
       │
       │ finish
       ▼
┌──────────────┐
│ wait server  │
└──────┬───────┘
       │
       ▼
   leaderboard
       │
       ▼
┌──────────────┐
│   Game #2    │
└──────────────┘
```

The problem is that **Game #2 is coupled to the server completing Game #1**.

---

# 4. New Architecture

The desired lifecycle is:

```text
┌──────────────┐
│   Game #1    │
│    ACTIVE    │
└──────┬───────┘
       │
       │ finish
       ▼
┌──────────────────────┐
│ Game #1              │
│ PENDING VERIFICATION │
└──────────────────────┘
       │
       │
       │ background
       │
       ▼
   SERVER QUEUE
```

At the same time, the player can immediately start:

```text
┌──────────────┐
│   Game #2    │
│    ACTIVE    │
└──────────────┘
```

If Game #2 finishes before Game #1 is verified:

```text
┌──────────────────────┐
│ Game #1              │
│ PENDING VERIFICATION │
└──────────────────────┘


Player
  │
  ▼
┌──────────────────────┐
│ Game #2              │
│ PENDING VERIFICATION │
└──────────────────────┘
```

The player can then start Game #3:

```text
┌──────────────────────┐
│ Game #1              │
│ PENDING VERIFICATION │
└──────────────────────┘


┌──────────────────────┐
│ Game #2              │
│ PENDING VERIFICATION │
└──────────────────────┘


Player
  │
  ▼
┌──────────────┐
│ Game #3      │
│ ACTIVE       │
└──────────────┘
```

Therefore, at any point in time, a valid state can be:

```text
Game #1 = PENDING
Game #2 = PENDING
Game #3 = ACTIVE
```

---

# 5. Each Game Has Its Own Queue

This is another important architectural change.

The current conceptual structure is:

```text
games
└── current
      └── one ranked game
            └── checkpoint queue
```

The new structure should be:

```text
games
├── game-A
│     ├── receipt
│     └── queue
│
├── game-B
│     ├── receipt
│     └── queue
│
├── game-C
│     ├── receipt
│     └── queue
│
└── game-D
      ├── receipt
      └── queue
```

Each game is independently persistent.

Each game has its own:

- game ID;
- receipt;
- checkpoint state;
- submission queue;
- retry state;
- verification status;
- timestamps;
- server acknowledgement state.

This means that finishing Game A must not overwrite or invalidate Game B.

---

# 6. Game-Level Queue Model

A useful mental model is:

```text
PLAYER
  │
  │
  ├────────────────────────────────────────────┐
  │                                            │
  ▼                                            ▼

GAME A                                      GAME B
┌──────────────────┐                       ┌──────────────────┐
│ receipt           │                       │ receipt           │
│ queue             │                       │ queue             │
│ status: PENDING   │                       │ status: ACTIVE   │
└────────┬─────────┘                       └──────────────────┘
         │
         │ background
         ▼
      SERVER


GAME C
┌──────────────────┐
│ receipt           │
│ queue             │
│ status: PENDING   │
└────────┬─────────┘
         │
         │ background
         ▼
      SERVER
```

The queues are associated with games, not with the player globally.

---

# 7. Complete End-to-End Flow

The complete desired flow is:

```text
                         PLAYER
                           │
                           ▼
                    ┌──────────────┐
                    │   Game #1    │
                    │    ACTIVE    │
                    └──────┬───────┘
                           │
                           │ finish
                           ▼
                    ┌──────────────┐
                    │   Game #1    │
                    │    PENDING   │
                    └──────┬───────┘
                           │
                           │
                           │ background
                           ▼
                    ┌──────────────┐
                    │ SERVER QUEUE │
                    └──────┬───────┘
                           │
                           │
                           │
PLAYER                     │
  │                        │
  ▼                        │
┌──────────────┐           │
│   Game #2    │           │
│    ACTIVE    │           │
└──────┬───────┘           │
       │                   │
       │ finish            │
       ▼                   │
┌──────────────┐           │
│   Game #2    │───────────┤
│    PENDING   │           │
└──────────────┘           │
                           │
                           ▼
                    ┌──────────────┐
                    │   VERIFY     │
                    │   Game #1    │
                    │   Game #2    │
                    └──────┬───────┘
                           │
                           ▼
                     PostgreSQL
                           │
                           ▼
                      Leaderboard
```

The critical property is that **the player's gameplay path and the verification path are separate**.

---

# 8. The Two Independent Flows

There should effectively be two flows.

## Gameplay flow

```text
Player
  ↓
ACTIVE GAME
  ↓
finish
  ↓
persist locally
  ↓
PENDING
  ↓
start next game
```

This flow must be fast and must not wait for the server.

## Verification flow

```text
PENDING GAME
  ↓
client outbox
  ↓
server
  ↓
verification queue
  ↓
replay verification
  ↓
PostgreSQL
  ↓
leaderboard
```

This flow can take seconds or longer without blocking gameplay.

---

# 9. Example: Three Consecutive Games

Suppose the player plays three games very quickly.

### After Game A

```text
Game A
└── PENDING
```

The server is still processing it.

The player starts Game B.

```text
Game A = PENDING
Game B = ACTIVE
```

Then Game B finishes.

```text
Game A = PENDING
Game B = PENDING
```

The player immediately starts Game C.

```text
Game A = PENDING
Game B = PENDING
Game C = ACTIVE
```

Meanwhile the server might process them in any order:

```text
Game A ───────► VERIFIED
Game B ───────► VERIFYING
Game C ───────► waiting for submission
```

or:

```text
Game A ───────► VERIFYING
Game B ───────► VERIFIED
Game C ───────► VERIFYING
```

The player does not need to care about this ordering.

---

# 10. Important State Separation

The client should distinguish between:

```text
ACTIVE
```

and:

```text
PENDING_VERIFICATION
```

These states answer different questions.

### ACTIVE

> Is the player currently playing this game?

### PENDING_VERIFICATION

> Has the player finished this game, but has the server not yet made the result official?

Therefore:

```text
Game A = PENDING_VERIFICATION
```

does **not** mean:

> the player is still playing Game A.

It means:

> Game A is finished and is waiting for server processing.

This distinction is what allows Game B to become active.

---

# 11. Persistence Model

IndexedDB should conceptually contain:

```text
games
│
├── game-A
│   ├── receipt
│   ├── queue
│   ├── status
│   └── verification state
│
├── game-B
│   ├── receipt
│   ├── queue
│   ├── status
│   └── verification state
│
├── game-C
│   ├── receipt
│   ├── queue
│   ├── status
│   └── verification state
│
└── game-D
    ├── receipt
    ├── queue
    ├── status
    └── verification state
```

The storage layer must therefore stop assuming:

```text
"current" = the only ranked game
```

and instead treat:

```text
gameId = identity of an individual ranked run
```

---

# 12. Target State at Any Given Moment

A healthy client could look like:

```text
IndexedDB
│
├── Game A
│   ├── status: VERIFIED
│   └── queue: empty
│
├── Game B
│   ├── status: PENDING_VERIFICATION
│   └── queue: final submission
│
├── Game C
│   ├── status: PENDING_VERIFICATION
│   └── queue: final submission
│
└── Game D
    ├── status: ACTIVE
    └── queue: checkpoints
```

This is the desired model.

---

# 13. The Core Invariant

The architecture should enforce exactly one active ranked game:

```text
COUNT(status == ACTIVE) <= 1
```

But there should be no equivalent restriction such as:

```text
COUNT(status == PENDING_VERIFICATION) <= 1
```

The second restriction is precisely what we want to remove.

The desired invariant is:

```text
0 or 1 ACTIVE game
+
0..N PENDING games
+
any number of VERIFIED/REJECTED historical games
```

subject to a configurable maximum for pending submissions if backpressure is required.

---

# 14. What the Server Sees

The server should no longer think:

```text
Player
  ↓
Current ranked game
```

Instead:

```text
Player
  │
  ├── Game A → submission
  ├── Game B → submission
  ├── Game C → submission
  └── Game D → active/current
```

Each submission is independently identifiable by:

```text
gameId
requestId
```

and independently verifiable.

---

# 15. Final Architecture

The complete target architecture can be summarized as:

```text
                         ONE PLAYER
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
          GAME A          GAME B          GAME C
          PENDING         PENDING          ACTIVE
              │              │              │
              │              │              │
              ▼              ▼              │
          Queue A         Queue B            │
              │              │              │
              └──────┬───────┘              │
                     │                      │
                     ▼                      │
              BACKGROUND                    │
              SUBMISSION                    │
                     │                      │
                     ▼                      │
              SERVER QUEUE                  │
                     │                      │
                     ▼                      │
              VERIFICATION                  │
                     │                      │
                     ▼                      │
                 PostgreSQL                 │
                     │                      │
                     ▼                      │
                LEADERBOARD                 │
                                            │
                                            ▼
                                      PLAYER CONTINUES
                                        PLAYING GAME C
```

The key principle is:

```text
ONE PLAYER
    ↓
MANY RANKED GAME RECORDS
    ↓
EACH GAME HAS ITS OWN QUEUE
    ↓
ONLY ONE GAME IS ACTIVE
    ↓
ALL FINISHED GAMES CAN BE PENDING
    ↓
VERIFICATION HAPPENS IN THE BACKGROUND
```

The player should never have to wait for:

```text
replay verification
server acknowledgement
PostgreSQL write
leaderboard update
```

before starting the next ranked game.

The only thing the player must wait for is the **local game to finish and be durably saved**.