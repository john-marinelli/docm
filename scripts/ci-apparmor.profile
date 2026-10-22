# Disposable Ubuntu CI only. Permit Chromium to create its own sandbox without
# relaxing the host-wide unprivileged-user-namespace restriction.
abi <abi/4.0>,
include <tunables/global>

profile docm-ci /**/docm flags=(unconfined) {
  userns,
}

profile docm-electron-ci /**/node_modules/electron/dist/electron flags=(unconfined) {
  userns,
}
