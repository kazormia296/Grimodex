#!/usr/bin/env python3
"""Bounded lstat-only snapshots of source-selected public setup payload roots.

No contents, member paths, credentials, quota/capacity probe or symlink traversal.
Incomplete walks never supply numerical allocation totals.
"""
import json
import os
import stat
import sys
import time


def observe(roots, *, max_entries=500_000, seconds=60):
    deadline = time.monotonic() + seconds
    visited = 0
    union = {}
    components = []
    for label, root in roots:
        members = {}
        paths = {kind: 0 for kind in ("regular", "directory", "symlink")}
        regular_path_bytes = 0
        status = "observed"

        def walk(parent, name, depth=0, device=None):
            nonlocal visited, regular_path_bytes
            if visited >= max_entries or time.monotonic() >= deadline or depth > 64:
                raise ValueError("bounded-walk-incomplete")
            visited += 1
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if device is not None and info.st_dev != device:
                raise ValueError("device-crossing-incomplete")
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise ValueError("special-file-incomplete")
            kind = "directory" if stat.S_ISDIR(info.st_mode) else "regular" if stat.S_ISREG(info.st_mode) else "symlink"
            key = (info.st_dev, info.st_ino)
            # Identity metadata detects changing aliases even when blocks stay equal.
            metadata = (info.st_blocks * 512, kind, info.st_size, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)
            if key in members and members[key] != metadata:
                raise ValueError("changed-shared-inode-incomplete")
            members[key] = metadata
            paths[kind] += 1
            if kind == "regular":
                regular_path_bytes += info.st_size
            if not stat.S_ISDIR(info.st_mode):
                return
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                before = os.fstat(fd)
                if (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino):
                    raise ValueError("changed-root-incomplete")
                with os.scandir(fd) as entries:
                    for entry in entries:
                        walk(fd, entry.name, depth + 1, before.st_dev)
                after = os.fstat(fd)
                if (before.st_mtime_ns, before.st_ctime_ns, before.st_blocks) != (after.st_mtime_ns, after.st_ctime_ns, after.st_blocks):
                    raise ValueError("changed-directory-incomplete")
            finally:
                os.close(fd)

        try:
            # Open each ancestor without following links, rather than allowing a
            # raced intermediate directory to redirect enumeration outside scope.
            if not os.path.isabs(root) or os.path.normpath(root) != root or root == "/":
                raise ValueError("invalid-root-incomplete")
            parts = root.split("/")[1:]
            fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
            try:
                for part in parts[:-1]:
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = child
                info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode):
                    raise ValueError("root-not-payload-incomplete")
                walk(fd, parts[-1])
            finally:
                os.close(fd)
        except FileNotFoundError:
            status = "missing-or-disappeared"
        except ValueError as error:
            status = str(error)
        except OSError:
            status = "metadata-unavailable"
        complete = status == "observed"
        components.append({
            "id": label, "status": status,
            "device": str(info.st_dev) if complete else None,
            "allocatedBytes": str(sum(value[0] for value in members.values())) if complete else None,
            "uniqueInodes": str(len(members)) if complete else None,
            "regularLogicalBytes": str(sum(value[2] for value in members.values() if value[1] == "regular")) if complete else None,
            "regularPathLogicalBytes": str(regular_path_bytes) if complete else None,
            "kinds": {kind: {"paths": str(count), "uniqueInodes": str(sum(value[1] == kind for value in members.values()))}
                      for kind, count in paths.items()} if complete else None,
            "hardlinkAliases": str(paths["regular"] - sum(value[1] == "regular" for value in members.values())) if complete else None,
            "regularInodesWithMultipleLinks": str(sum(value[1] == "regular" and value[3] > 1 for value in members.values())) if complete else None,
        })
        if complete:
            for key, metadata in members.items():
                if key in union and union[key] != metadata:
                    # Sequential snapshots are not an atomic filesystem freeze.
                    return {"components": components, "coexistence": None, "status": "changed-shared-inode"}
                union[key] = metadata
    devices = sorted({key[0] for key in union})
    return {"components": components, "coexistence": [
        {"device": str(device), "allocatedBytes": str(sum(value[0] for key, value in union.items() if key[0] == device)),
         "uniqueInodes": str(sum(1 for key in union if key[0] == device))}
        for device in devices
    ], "status": "observed-roots-only"}


if __name__ == "__main__":
    try:
        roots = json.loads(sys.argv[1])
        if not isinstance(roots, list) or not roots or len(roots) > 17:
            raise ValueError()
        labels = set()
        for label, root in roots:
            if not isinstance(label, str) or not label.replace("-", "").isalnum() or label in labels or not isinstance(root, str):
                raise ValueError()
            labels.add(label)
        print(json.dumps(observe(roots)))
    except Exception:
        print("[artifact] setup allocation observation unavailable", file=sys.stderr)
        sys.exit(1)
