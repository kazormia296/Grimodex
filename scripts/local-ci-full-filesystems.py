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


if __name__ == "__main__":
    try:
        request = json.loads(sys.argv[1])
        # sudo changes the probe identity; quotas must concern the actual caller.
        if set(request) != {"locations", "uid", "gids"}:
            raise ValueError("invalid scoped filesystem request")
        if not isinstance(request["uid"], int) or request["uid"] < 0:
            raise ValueError("invalid caller identity")
        if not request["gids"] or any(not isinstance(g, int) or g < 0 for g in request["gids"]):
            raise ValueError("invalid caller groups")
        print(json.dumps(inspect(request["locations"], request["uid"], request["gids"])))
    except Exception as error:
        # Only source-owned failure classes, not paths/argv/environment, escape.
        print("[precheck] Full scoped filesystem/quota acquisition failed: " + str(error) if isinstance(error, ValueError)
              else "[precheck] Full scoped filesystem/quota acquisition unavailable", file=sys.stderr)
        sys.exit(1)
