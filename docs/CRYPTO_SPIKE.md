# E2EE Crypto Spike

The backend and mobile app expose stable key/message interfaces, but the placeholder in
`HM-Frontend/src/services/crypto/e2ee.ts` must be replaced before any private beta.

## Required outcome

- Keep Expo, but use Expo development builds only. Expo Go is not a target.
- Use `HM-Frontend/modules/hm-e2ee` as the native module boundary.
- Android must link Signal artifacts from `https://build-artifacts.signal.org/libraries/maven/`.
- iOS must link Signal Swift/libsignal artifacts or the app must move to Bare React Native before private beta.
- Generate identity keys, signed prekeys, and one-time prekeys on device.
- Establish a one-to-one session between two real devices.
- Encrypt/decrypt text messages offline after session creation.
- Prove group sender-key rotation after removing a member.
- Run on Expo development builds for Android and iOS.

## Hard rule

Do not ship custom cryptography. If a Signal/libsignal binding cannot run reliably in Expo
development builds, migrate the mobile app to Bare React Native before building production chat.

## Current decision

Expo remains viable for Android because development builds can include native code and Signal publishes Android artifacts. The app now contains a custom Expo module boundary named `hm-e2ee`.

iOS is unresolved until a real Swift/libsignal binding is linked and smoke-tested. The iOS module returns unavailable by default, so the app fails closed.
