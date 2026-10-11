#!/usr/bin/env python3
"""Read only the Full consumer filesystems and their applicable Linux quotas.

Invoked by the existing supervisor, with sudo -n only for quota visibility.
No installation, quota mutation, foreign process enumeration, or cleanup.
"""
import ctypes
import errno
import fcntl
import json
import os
import pathlib
import stat
import struct
import sys
import time


class Dqinfo(ctypes.Structure):
    _fields_ = [("bgrace", ctypes.c_uint64), ("igrace", ctypes.c_uint64),
                ("flags", ctypes.c_uint32), ("valid", ctypes.c_uint32)]


class Dqblk(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in
                ("bhard", "bsoft", "space", "ihard", "isoft", "inodes", "btime", "itime")]
    _fields_ += [("valid", ctypes.c_uint32)]


def unescape(value):
    # mountinfo escapes space/tab/newline/backslash; do not interpret other text.
    for encoded, decoded in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
        value = value.replace(encoded, decoded)
    return value


def remaining(hard, soft, used, expires, now):
    limits = [hard] if hard else []
    # A new grace period is not a reservation for the lifetime of Full. Treat
    # an applicable soft limit as a ceiling even while grace is still active.
    if soft:
        limits.append(soft)
    if soft and used > soft and expires and expires <= now:
        return 0
    return max(0, min(limits) - used) if limits else None


def inspect(locations, uid, gids, *, libc=None, mountinfo=None):
    libc = libc or ctypes.CDLL(None, use_errno=True)
    libc.quotactl.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
    libc.quotactl.restype = ctypes.c_int
    if mountinfo is None:
        with open("/proc/self/mountinfo", encoding="utf-8") as stream:
            mountinfo = stream.read()
    mounts = []
    for line in mountinfo.splitlines():
        left, right = line.split(" - ", 1)
        fields, filesystem = left.split(), right.split()
        options = set(fields[5].split(",")) | set(filesystem[2].split(","))
        mounts.append((unescape(fields[4]), filesystem[0], unescape(filesystem[1]), options))
    results = []
    for label, requested in locations:
        if not os.path.isabs(requested):
            raise ValueError("absolute consumer location required")
        ancestor = requested
        while not os.path.exists(ancestor):
            parent = os.path.dirname(ancestor)
            if parent == ancestor:
                raise ValueError("consumer ancestor unavailable")
            ancestor = parent
        resolved = os.path.realpath(ancestor)
        if not os.path.isdir(resolved):
            raise ValueError("consumer ancestor is not a directory")
        candidates = [m for m in mounts if resolved == m[0] or resolved.startswith(m[0].rstrip("/") + "/")]
        if not candidates:
            raise ValueError("actual consumer mount unavailable")
        mount, kind, special, options = max(candidates, key=lambda m: len(m[0]))
        # Generic Linux quotactl structures below are applicable to ext4 only.
        # Overlay/XFS/network/project-unknown filesystems need their real quota
        # acquisition operation, not an empty-quota attestation.
        if kind == "tmpfs":
            results.append(inspect_tmpfs(label, resolved, mount, options))
            continue
        if kind != "ext4" or not special.startswith("/dev/"):
            raise ValueError("missing quota acquisition for actual filesystem type " + kind)
        fs = os.statvfs(resolved)
        if fs.f_flag & os.ST_RDONLY:
            raise ValueError("consumer filesystem is read-only")
        destination = os.stat(resolved)
        # SGID directories and ext4 grpid/bsdgroups mounts charge new files (and
        # descendants) to the parent group, possibly outside caller membership.
        groups = set(gids)
        if destination.st_mode & stat.S_ISGID or options & {"grpid", "bsdgroups"}:
            groups.add(destination.st_gid)
        quotas = []
        for quota_type, identities in ((0, [uid]), (1, sorted(groups)), (2, None)):
            info = Dqinfo()
            # QCMD(Q_GETINFO, type); ESRCH is the kernel's disabled-quota result.
            code = libc.quotactl((0x800005 << 8) | quota_type, os.fsencode(special), 0, ctypes.byref(info))
            if code != 0:
                if ctypes.get_errno() == errno.ESRCH:
                    quotas.append({"type": quota_type, "state": "kernel-disabled"})
                    continue
                raise ValueError("applicable quota state unavailable")
            if quota_type == 2:
                fd = os.open(resolved, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    attributes = bytearray(28)
                    fcntl.ioctl(fd, 0x801C581F, attributes, True)  # FS_IOC_FSGETXATTR
                    flags, _, _, project, _ = struct.unpack_from("=IIIII", attributes)
                    identities = [project if ancestor == requested or flags & 0x200 else 0]
                finally:
                    os.close(fd)
            for identity in identities:
                block = Dqblk()
                code = libc.quotactl((0x800007 << 8) | quota_type, os.fsencode(special), identity, ctypes.byref(block))
                # An enabled domain without a readable current-identity record
                # is unknown, not evidence of unlimited quota.
                if code != 0 or block.valid & 0x3F != 0x3F:
                    raise ValueError("applicable current-identity quota unavailable")
                now = int(time.time())
                available_bytes = remaining(block.bhard * 1024, block.bsoft * 1024, block.space, block.btime, now)
                available_inodes = remaining(block.ihard, block.isoft, block.inodes, block.itime, now)
                quotas.append({
                    "type": quota_type, "state": "kernel-enabled",
                    "bytes": str(available_bytes) if available_bytes is not None else None,
                    "inodes": str(available_inodes) if available_inodes is not None else None,
                })
        results.append({
            "label": label, "device": str(destination.st_dev),
            "bytes": str(fs.f_bavail * fs.f_frsize), "inodes": str(fs.f_favail),
            "allocationUnit": str(fs.f_frsize), "quotas": quotas,
        })
    return results


def inspect_tmpfs(label, resolved, mountpoint, options):
    # tmpfs quotas are enabled by mount options, not ext4's /dev quotactl.
    # Never translate an enabled/unsupported domain into unlimited headroom.
    if any("quota" in option.split("=", 1)[0] for option in options):
        raise ValueError("enabled or unknown tmpfs quota acquisition unsupported")
    fs = os.statvfs(resolved)
    if fs.f_flag & os.ST_RDONLY or "rw" not in options:
        raise ValueError("consumer tmpfs is not writable")
    return {"label": label, "device": str(os.stat(resolved).st_dev),
            "bytes": str(fs.f_bavail * fs.f_frsize), "inodes": str(fs.f_favail),
            "allocationUnit": str(fs.f_frsize), "mount": mountpoint,
            "quotas": [{"type": kind, "state": "kernel-disabled"} for kind in (0, 1, 2)]}


def assess_memory(memory, expected_cgroup, demand):
    # Used only inside fixed INITIAL setup before chroot/drop, no child probe.
    if memory["membership"] != expected_cgroup or not 0 <= int(time.time() * 1000) - memory["observedAt"] <= 30_000:
        raise ValueError("fresh same-owner memory acquisition required")
    available = int(memory["host"]["MemAvailable"])
    total = int(memory["host"]["MemTotal"])
    swap_free, swap_total = (int(memory["host"][key]) for key in ("SwapFree", "SwapTotal"))
    if available > total or swap_free > swap_total:
        raise ValueError("inconsistent actual host memory/swap")
    for psi in [memory["pressure"], *(entry["pressure"] for entry in memory["ancestors"])]:
        if any(float(psi[kind][key]) != 0 for kind in ("some", "full") for key in ("avg10", "avg60", "avg300")):
            raise ValueError("current host or memory ancestor pressure")
    for entry in memory["ancestors"]:
        if entry["state"] == "kernel-root-no-controller-limit" and entry["path"] == ".":
            continue
        if entry["state"] != "kernel-accounted":
            raise ValueError("unknown memory ancestor state")
        current = int(entry["memory.current"])
        for key in ("memory.max", "memory.high"):
            if entry[key] != "max":
                available = min(available, max(0, int(entry[key]) - current))
        if int(entry["memory.swap.current"]) > swap_total:
            raise ValueError("inconsistent memory ancestor swap")
    if demand <= 0 or available <= demand:
        raise ValueError("complete reviewed Full memory risk exceeds same-owner headroom")
    return {"available": str(available), "demand": str(demand), "swapFree": str(swap_free), "swapTotal": str(swap_total)}


def inspect_memory(expected_cgroup, *, proc=pathlib.Path("/proc"), cgroups=pathlib.Path("/sys/fs/cgroup")):
    membership = (proc / "self/cgroup").read_text()
    if membership != expected_cgroup or not membership.startswith("0::/") or len(membership.splitlines()) != 1:
        raise ValueError("same-owner unified cgroup membership required (v1 unsupported)")
    relative = membership.strip()[3:]
    if any(part == ".." for part in pathlib.PurePosixPath(relative).parts):
        raise ValueError("unredirected memory cgroup path required")
    mounts = []
    for line in (proc / "self/mountinfo").read_text().splitlines():
        left, right = line.split(" - ", 1)
        fields, system = left.split(), right.split()
        if system[0] == "cgroup2":
            mounts.append(fields)
    if len(mounts) != 1 or unescape(mounts[0][3]) != "/" or unescape(mounts[0][4]) != str(cgroups):
        raise ValueError("all actual memory cgroup ancestors visible on the owned host")
    host = {}
    for line in (proc / "meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        if key in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
            parts = value.split()
            if len(parts) != 2 or parts[1] != "kB" or not parts[0].isdigit():
                raise ValueError("actual host memory/swap units required")
            host[key] = str(int(parts[0]) * 1024)
    if set(host) != {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
        raise ValueError("complete host memory/swap facts required")
    def pressure(file):
        lines = file.read_text().splitlines()
        parsed = {}
        for line in lines:
            kind, *items = line.split()
            values = dict(item.split("=", 1) for item in items)
            if kind not in ("some", "full") or set(values) != {"avg10", "avg60", "avg300", "total"}:
                raise ValueError("actual memory PSI acquisition unsupported")
            for key, value in values.items():
                if key == "total":
                    if not value.isdigit():
                        raise ValueError("actual memory PSI total required")
                elif not value.replace(".", "", 1).isdigit():
                    raise ValueError("actual memory PSI average required")
            parsed[kind] = values
        if set(parsed) != {"some", "full"}:
            raise ValueError("complete memory PSI facts required")
        return parsed
    ancestors = []
    directory = cgroups / relative.lstrip("/")
    while True:
        if directory.is_symlink() or directory.resolve(strict=True) != directory:
            raise ValueError("actual memory ancestor redirected")
        record = {"path": str(directory.relative_to(cgroups)) or ".", "pressure": pressure(directory / "memory.pressure")}
        if directory == cgroups and not (directory / "memory.current").exists():
            # Kernel root cgroup has no memory-controller limit/accounting knobs;
            # host MemAvailable is its real finite ceiling, never invented max.
            if "memory" not in (directory / "cgroup.controllers").read_text().split() or (directory / "memory.max").exists():
                raise ValueError("root memory controller state unsupported")
            record["state"] = "kernel-root-no-controller-limit"
        else:
            record["state"] = "kernel-accounted"
            for name in ("memory.current", "memory.max", "memory.high", "memory.swap.current", "memory.swap.max"):
                value = (directory / name).read_text().strip()
                if not value.isdigit() and not (value == "max" and name.endswith((".max", ".high"))):
                    raise ValueError("actual memory ancestor accounting/limits required")
                record[name] = value
        ancestors.append(record)
        if directory == cgroups:
            break
        directory = directory.parent
    if (proc / "self/cgroup").read_text() != membership:
        raise ValueError("memory owner membership changed during acquisition")
    return {"membership": membership, "mount": mounts[0][0], "host": host,
            "pressure": pressure(proc / "pressure/memory"), "ancestors": ancestors,
            "observedAt": int(time.time() * 1000)}


if __name__ == "__main__":
    try:
        request = json.loads(sys.argv[1])
        # sudo changes the probe identity; quotas must concern the actual caller.
        if set(request) not in ({"locations", "uid", "gids"}, {"locations", "uid", "gids", "memoryCgroup"}):
            raise ValueError("invalid scoped filesystem request")
        if not isinstance(request["uid"], int) or request["uid"] < 0:
            raise ValueError("invalid caller identity")
        if not request["gids"] or any(not isinstance(g, int) or g < 0 for g in request["gids"]):
            raise ValueError("invalid caller groups")
        filesystems = inspect(request["locations"], request["uid"], request["gids"])
        if "memoryCgroup" in request:
            if not isinstance(request["memoryCgroup"], str):
                raise ValueError("actual caller cgroup membership required")
            print(json.dumps({"filesystems": filesystems, "memory": inspect_memory(request["memoryCgroup"])}))
        else:
            print(json.dumps(filesystems))
    except Exception as error:
        # Only source-owned failure classes, not paths/argv/environment, escape.
        print("[precheck] Full scoped filesystem/quota acquisition failed: " + str(error) if isinstance(error, ValueError)
              else "[precheck] Full scoped filesystem/quota acquisition unavailable", file=sys.stderr)
        sys.exit(1)
