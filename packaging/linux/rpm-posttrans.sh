#!/bin/sh

# RPM upgrades run the new package's %post before removing the old package's
# obsolete payload and running its %postun. The published Tauri RPM owns
# /usr/bin/grimodex directly, while electron-builder creates that launcher from
# %post. A final %posttrans is therefore required to restore the launcher after
# the whole transaction. Future Electron upgrades need the same repair because
# the old Electron %postun removes its alternatives/AppArmor state.

package_name="grimodex"
executable="grimodex"
app_dir="/opt/Grimodex"
app_executable="${app_dir}/${executable}"
launcher="/usr/bin/${executable}"

# Do nothing on a final erase or an incomplete transaction. This also makes the
# script safe if an RPM implementation invokes %posttrans for erase operations.
if ! rpm -q "${package_name}" >/dev/null 2>&1 || [ ! -x "${app_executable}" ]; then
  exit 0
fi

if command -v update-alternatives >/dev/null 2>&1; then
  if [ -L "${launcher}" ] && [ -e "${launcher}" ] &&
    [ "$(readlink "${launcher}")" != "/etc/alternatives/${executable}" ]; then
    rm -f "${launcher}"
  fi
  update-alternatives --install "${launcher}" "${executable}" "${app_executable}" 100 ||
    ln -sf "${app_executable}" "${launcher}"
else
  ln -sf "${app_executable}" "${launcher}"
fi

# Match electron-builder's default post-install sandbox decision.
if ! { [ -L /proc/self/ns/user ] && unshare --user true; }; then
  chmod 4755 "${app_dir}/chrome-sandbox" || true
else
  chmod 0755 "${app_dir}/chrome-sandbox" || true
fi

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi

# An old Electron %postun can remove the newly installed profile during an
# upgrade. Restore it only when the host AppArmor supports the bundled ABI.
apparmor_source="${app_dir}/resources/apparmor-profile"
apparmor_target="/etc/apparmor.d/${executable}"
if [ -f "${apparmor_source}" ] &&
  command -v apparmor_status >/dev/null 2>&1 &&
  apparmor_status --enabled >/dev/null 2>&1 &&
  command -v apparmor_parser >/dev/null 2>&1; then
  if apparmor_parser --skip-kernel-load --debug "${apparmor_source}" >/dev/null 2>&1; then
    cp -f "${apparmor_source}" "${apparmor_target}"
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
      apparmor_parser --replace --write-cache --skip-read-cache "${apparmor_target}" || true
    fi
  fi
fi

exit 0
