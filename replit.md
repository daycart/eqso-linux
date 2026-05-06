# eQSO Linux Client

A web-based client and server application for eQSO radio linking, enabling users to connect via web or traditional eQSO Windows clients.

## Run & Operate

- **Typecheck all packages**: `pnpm run typecheck`
- **Build all packages**: `pnpm run build`
- **Generate API hooks and Zod schemas**: `pnpm --filter @workspace/api-spec run codegen`
- **Push DB schema changes (dev only)**: `pnpm --filter @workspace/db run push`
- **Run API server locally**: `pnpm --filter @workspace/api-server run dev`

**Required Environment Variables**:
- `EQSO_PASSWORD`: Password for the local TCP server (Windows eQSO clients).
- `RELAY_TOKENS`: Comma-separated tokens for relay daemon authentication.
- `DATABASE_URL`: PostgreSQL connection string.
- `EQSO_TCP_PORT`: Port for the eQSO TCP server (default: 2171).

## Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24
- **TypeScript**: 5.9
- **API Framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API Codegen**: Orval (from OpenAPI spec)
- **Build Tool**: esbuild (CJS bundle)
- **WebSockets**: `ws` library
- **Audio Codec**: GSM 06.10 (libgsm)

## Where things live

- **eQSO Linux Client (web app)**: `artifacts/eqso-client`
- **API Server**: `artifacts/api-server`
- **eQSO Linux Client public assets**: `public/` (e.g., `public/mic-worklet.js`)
- **Relay Daemon**: `artifacts/relay-daemon`
- **Database Schema**: `packages/db/schema.ts`
- **API Contracts**: `packages/api-spec/` (OpenAPI spec)

## Architecture decisions

- **Unified Room Management**: eQSO TCP server, WebSocket bridge, and Relay Manager all share the same `RoomManager` for cross-client audio relay.
- **Real-time Audio Processing**: Custom AudioWorklet with anti-aliasing and carry buffer ensures smooth 8kHz PCM audio for PTT, addressing hardware stabilization and sample discontinuity.
- **Soft-clipping for TX Audio**: `WaveShaperNode` with `tanh` function replaces `DynamicsCompressor` to prevent severe hard clipping, maintaining audio quality.
- **GSM Codec for Real-time TX**: Pure TypeScript `TsGsmEncoder` is used for synchronous per-frame encoding to ensure real-time transmission, bypassing `ffmpeg`'s buffering issues for encoding.
- **Separate RX/TX Audio Chains**: Dedicated `FfmpegGsmDecoder` for RX (streaming process for reliability) and `TsGsmEncoder` for TX (pure TS for real-time) to optimize for each use case.

## Product

- **eQSO Client (Web)**: React + Vite web application for eQSO radio linking with PTT, room management, and user lists.
- **eQSO Server (TCP/WebSocket)**: Handles connections from both eQSO Windows clients (TCP) and the web client (WebSocket), enabling audio and PTT across platforms.
- **Relay Management System**: Allows administrators to configure persistent connections to external eQSO servers, bridging local rooms with remote ones.
- **User Authentication**: Secure user registration, login, and session management with different roles (user, admin) and access controls.
- **Admin Panel**: Provides tools for managing users, relays, and monitoring server status.
- **Relay Daemon**: A Node.js daemon for physical radio interfacing (CB radio via CM108 USB) with VOX and PTT control.

## User preferences

- _Populate as you build_

## Gotchas

- **PTT Race Condition**: Audio chunks arriving before `ptt_granted` are buffered and flushed, not dropped.
- **Relay Daemon `arecord` stability**: `arecord` is prone to crashes in VirtualBox. The `resetUsbAudio()` method in `alsa-audio.ts` (using `modprobe`) is critical for restarting `arecord` after `aplay` closes.
- **PCM to Float32 Normalization**: Normalization is now a fixed division by `/32768` instead of per-packet to prevent "distorted voice" artifacts during pauses.
- **Remote Mode Configuration**: When using the web client in remote mode, ensure `FfmpegGsmDecoder` is correctly imported and `EqsoProxy.sendJoin()` buffers the JOIN packet until the handshake is complete.
- **CM108 USB 8kHz Playback**: VirtualBox's CM108 USB audio device does not accept 8kHz playback directly via ALSA. Audio is upsampled to 48kHz before playing.

## Pointers

- **pnpm-workspace skill**: For workspace structure, TypeScript setup, and package details.
- **Drizzle ORM documentation**: For database interactions.
- **Zod documentation**: For schema validation.
- **Orval documentation**: For API client generation.
- **eQSO Protocol**: Binary protocol reverse-engineered from OSQe.
- **GSM 06.10 Codec**: Details on the audio compression standard.
- **Replit Deployment**: For deploying the API server on Replit.
- **GitHub Pages Deployment**: For deploying the web client.