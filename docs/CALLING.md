# Audio Calling Architecture

## Scope

- Audio-only calls.
- Direct calls and group calls.
- Expo development builds only; Expo Go is not supported for WebRTC.
- LiveKit handles WebRTC media transport.
- Socket.IO handles ringing and transient call state.
- Expo push handles offline incoming-call alerts.

## Why LiveKit

LiveKit provides the SFU layer needed for group calls, a React Native/Expo SDK path, reconnect handling, track management, and optional media E2EE. Raw WebRTC would require building and maintaining this layer in-house.

## Backend Contracts

- `POST /calls/direct`
- `POST /calls/group`
- `POST /calls/:id/token`
- `POST /calls/:id/reject`
- `POST /calls/:id/end`
- `GET /calls/history`

## Socket Events

- Client emits `call:ring` after creating a call.
- Server emits `call:incoming` to online recipients.
- Client emits `call:accepted`, `call:rejected`, and `call:ended`.

## Native Call UI

`HM-Frontend/modules/hm-native-calls` is the native boundary for iOS CallKit and Android full-screen call notifications.

## E2EE For Calls

Call E2EE is mandatory in the client:

- The backend issues LiveKit room tokens and includes `livekit.e2ee.required: true`.
- The caller generates a per-call media key locally.
- The media key is stored only in client memory for the active call.
- The caller encrypts the media key to every invited participant device using the chat E2EE envelope path.
- Socket.IO relays only opaque `call:key` envelopes and rejects plaintext-looking key fields.
- The LiveKit React Native client uses `RNKeyProvider` and `RNE2EEManager` before joining the room.
- The app fails closed if a participant tries to join without the matching call media key.

## Production Checklist

- Configure public `LIVEKIT_URL` over TLS.
- Configure TURN/Coturn for hard NAT networks.
- Open UDP media port range on the VPS/firewall.
- Implement iOS CallKit and Android Telecom native modules.
- Add call timeout worker for missed calls.
- Add call quality telemetry: jitter, packet loss, reconnects, device route.
- Run two-device tests on different networks.
