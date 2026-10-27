# Disposable Ubuntu CI only. Permit a Homebrew-installed docm to create its own
# Chromium sandbox without relaxing the host-wide user-namespace restriction.
# The .deb and .rpm packages install their own profile for /opt/Docm/docm.
abi <abi/4.0>,
include <tunables/global>

profile docm-ci /home/linuxbrew/.linuxbrew/Cellar/docm/*/libexec/docm flags=(unconfined) {
  userns,
}
