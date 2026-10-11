"""Fixed B-native-privileged-setup-v1 initializer; not a command executor.

Only the existing Linux journey wrapper calls this in fresh mount/net/PID/IPC
namespaces. Root is used for setup only. No installation or fallback exists.
"""
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import re
import runpy
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

LIBC = ctypes.CDLL(None, use_errno=True)
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 1 << 18
RECEIPT = "/run/grimodex-native-b/admission.json"
RUNTIME = ("/usr", "/lib", "/lib64")
CHECKOUT = ("electron", "src", "src-tauri", "scripts", "dist", "dist-electron",
            "node_modules", "public", "resources")
WORKSPACES = ("scan-contract", "scan-core")
CLOSED = False
SIOCGIFCONF, SIOCGIFFLAGS, SIOCSIFFLAGS, IFF_UP, RTF_REJECT = 0x8912, 0x8913, 0x8914, 0x1, 0x200
IFREQ = "16sH22x"
IFREQ_SIZE = struct.calcsize(IFREQ)


class IfConf(ctypes.Structure):
    _fields_ = [("length", ctypes.c_int), ("buffer", ctypes.c_void_p)]


def require(value, message):
    if not value:
        raise RuntimeError(message)


def mount(source, target, kind=None, flags=0, data=None):
    encode = lambda value: None if value is None else os.fsencode(value)
    if LIBC.mount(encode(source), encode(target), encode(kind), ctypes.c_ulong(flags), encode(data)) != 0:
        raise OSError(ctypes.get_errno(), "native B mount refused")


def private_path(root, absolute):
    require(absolute.startswith("/") and ".." not in pathlib.PurePosixPath(absolute).parts,
            "native B invalid root path")
    return root / absolute.lstrip("/")


def bind(root, source, *, readonly=True):
    source = pathlib.Path(source)
    require(source.exists() and not source.is_symlink(), "native B source missing or redirected")
    target = private_path(root, str(source))
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        target.mkdir(exist_ok=True)
    else:
        target.touch(exist_ok=False)
    # Never recurse: host submounts must not appear in the private root.
    mount(str(source), str(target), flags=MS_BIND)
    # A later exec must not regain root via setuid/setgid or file capabilities.
    flags = MS_BIND | MS_REMOUNT | MS_NOSUID | MS_NODEV
    if readonly:
        flags |= MS_RDONLY
    mount(None, str(target), flags=flags)


def journey_paths(args):
    if args == ["electron/scripts/product-journeys.mjs"]:
        return ".artifacts/native-b-root", None
    require(len(args) == 6 and args[:2] == ["electron/scripts/product-journey-shards.mjs", "run"] and
            args[2] == "--shard" and args[3] in tuple(str(n) for n in range(1, 8)) and
            args[4] == "--output-dir" and
            re.fullmatch(r"\.artifacts/local-ci/runs/[A-Za-z0-9_-]+/product-journeys", args[5]),
            "native B only the existing canonical journey command is admitted")
    run = hashlib.sha256(args[5].encode("utf-8")).hexdigest()
    return f".artifacts/native-b-root-{run}-shard-{args[3]}", f"{args[5]}/shard-{args[3]}"


def owned_directory(checkout, relative, uid, gid):
    # mkdir under ordinary effective credentials: concurrent initializers must
    # never observe a transient root-owned common parent between mkdir/chown.
    # This is setup-only; permanent UID/group/cap/FD drop still precedes children.
    original_uid, original_gid = os.geteuid(), os.getegid()
    try:
        if original_uid == 0:
            os.setegid(gid)
            os.seteuid(uid)
        require(os.geteuid() == uid and os.getegid() == gid, "native B owner allocation identity invalid")
        parts = pathlib.PurePosixPath(relative).parts
        directory = checkout
        for index, part in enumerate(parts):
            require(part not in ("", ".", "..") and not part.startswith("/"), "native B invalid owner path")
            directory = directory / part
            try:
                directory.mkdir(mode=0o700)
            except FileExistsError:
                require(index < len(parts) - 1, "native B prior owner/output retained")
            metadata = directory.lstat()
            require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == uid and metadata.st_gid == gid and
                    metadata.st_mode & 0o022 == 0, "native B owner ancestor redirected or unsafe")
            # Persist exclusive ownership before mounts or child admission.
            descriptor = os.open(directory.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return directory
    finally:
        if original_uid == 0:
            os.seteuid(original_uid)
            os.setegid(original_gid)


def audit_checkout(source, admitted, workspace_links=None):
    for directory, directories, files in os.walk(source, followlinks=False):
        for name in directories + files:
            entry = pathlib.Path(directory) / name
            mode = entry.lstat().st_mode
            require(not stat.S_ISSOCK(mode) and not stat.S_ISFIFO(mode) and
                    not stat.S_ISCHR(mode) and not stat.S_ISBLK(mode),
                    "native B checkout contains a non-file runtime entry")
            require(name not in (".git", ".ralph", ".env", ".npmrc", ".netrc") and
                    not name.startswith(".env."), "native B checkout contains excluded configuration")
            if entry.is_symlink():
                resolved = entry.resolve(strict=True)
                if workspace_links and entry in workspace_links:
                    require(resolved == workspace_links[entry], "native B workspace link redirected")
                else:
                    require(any(resolved == base or base in resolved.parents for base in admitted),
                            "native B checkout symlink escapes admitted sources")


def exact_file(checkout, relative):
    require(isinstance(relative, str) and relative and "\0" not in relative and
            not relative.startswith("/") and
            all(part not in ("", ".", "..") for part in relative.split("/")),
            "native B exact source path invalid")
    source = checkout / relative
    require(source.resolve(strict=True) == source and stat.S_ISREG(source.lstat().st_mode),
            "native B exact source redirected or not a file")
    return source


def workspace_sources(checkout):
    # pnpm's two locked root aliases need package.json + prebuilt dist, not a
    # broad packages mount. Tracked workspace sources are bound individually.
    sources, links = [], {}
    for name in WORKSPACES:
        package = checkout / "packages" / name
        manifest = exact_file(checkout, f"packages/{name}/package.json")
        dist = package / "dist"
        require(dist.resolve(strict=True) == dist and dist.is_dir(),
                "native B workspace build missing or redirected")
        alias = checkout / "node_modules" / "@grimodex" / name
        require(alias.is_symlink() and alias.resolve(strict=True) == package,
                "native B workspace link missing or redirected")
        sources.extend((manifest, dist))
        links[alias] = package
    return sources, links


def git_sources(checkout, view):
    require(isinstance(view, dict) and set(view) == {"head", "base", "tracked"} and
            all(isinstance(view[key], str) and re.fullmatch(r"[0-9a-f]{40}", view[key])
                for key in ("head", "base")), "native B Git identity invalid")
    tracked = view["tracked"]
    require(isinstance(tracked, list) and tracked and len(tracked) == len(set(tracked)),
            "native B tracked source set invalid")
    sources = []
    for relative in tracked:
        require(isinstance(relative, str) and not any(part in (".git", ".ralph", ".env", ".netrc") or
                part.startswith(".env.") for part in relative.split("/")),
                "native B tracked source excluded")
        sources.append(exact_file(checkout, relative))
    exact_file(checkout, ".git/index")
    objects = checkout / ".git/objects"
    require(objects.resolve(strict=True) == objects and objects.is_dir(), "native B Git objects redirected")
    # Only native Git object files. No alternates, config, hooks, refs with
    # arbitrary paths, promisor/remote transport or credential-bearing metadata.
    for directory, directories, files in os.walk(objects, followlinks=False):
        for name in directories + files:
            entry = pathlib.Path(directory) / name
            relative = entry.relative_to(objects).as_posix()
            require(not entry.is_symlink(), "native B Git object alias rejected")
            if entry.is_dir():
                require(relative in ("pack", "info") or re.fullmatch(r"[0-9a-f]{2}", relative),
                        "native B Git object directory invalid")
            else:
                require(stat.S_ISREG(entry.lstat().st_mode) and
                        (re.fullmatch(r"[0-9a-f]{2}/[0-9a-f]{38}", relative) or
                         re.fullmatch(r"pack/pack-[0-9a-f]{40}\.(pack|idx|rev)", relative)),
                        "native B Git external or non-object metadata rejected")
    return sources


def evidence_sources(checkout, environment):
    sources = []
    receipt = environment.get("GRIMODEX_C2ZC_RUST_RECEIPT_PATH")
    if receipt:
        require(receipt == ".artifacts/local-ci/c2-zc-rust-acceptance.json",
                "native B Rust receipt path not canonical")
        sources.extend(exact_file(checkout, name) for name in (receipt, receipt + ".sha256"))
    fixture = environment.get("GRIMODEX_C2ZC_RESTORE_FIXTURE")
    if fixture:
        fixture = json.loads(fixture)
        require(isinstance(fixture, dict) and set(fixture) == {"path", "manifest"},
                "native B fixture selectors invalid")
        base = checkout / ".artifacts/local-ci/c2-zc-restore-fixture"
        manifest = pathlib.Path(fixture["manifest"])
        require(manifest.is_absolute() and manifest.parent.parent == base and
                re.fullmatch(r"[A-Za-z0-9_-]+", manifest.parent.name) and
                manifest.name == "c2zc-restore-fixture.manifest.json" and
                fixture["path"] == str(manifest.parent / "c2zc-restore-fixture.backup.db"),
                "native B fixture paths not canonical")
        sources.extend(exact_file(checkout, str((manifest.parent / name).relative_to(checkout))) for name in
                       ("c2zc-restore-fixture.manifest.json", "c2zc-restore-fixture.backup.db", "c2zc-restore-fixture.db"))
    # The unchanged harness verifies live candidate, bytes, sidecar, manifest
    # and artifact hashes; no regenerated receipt or acceptance Boolean here.
    return sources


def resource_owner(checkout, value):
    reference = value["resourceAdmission"]
    qualification = value["qualification"]
    require(isinstance(reference, dict) and set(reference) == {"path", "sha256"} and
            re.fullmatch(r"[0-9a-f]{64}", reference["sha256"]), "native B host resource reference invalid")
    expected = f'.artifacts/local-ci/full-admission/{qualification["run"]}-{qualification["attempt"]}-host/decision.json'
    require(reference["path"] == expected, "native B host resource path not canonical")
    file = exact_file(checkout, expected)
    metadata = file.stat()
    require(metadata.st_uid == value["uid"] and stat.S_IMODE(metadata.st_mode) == 0o600,
            "native B host resource receipt owner invalid")
    data = file.read_bytes()
    require(hashlib.sha256(data).hexdigest() == reference["sha256"], "native B host resource receipt changed")
    host = json.loads(data)
    binding = host["binding"]
    local_run = re.fullmatch(r"\.artifacts/local-ci/runs/([0-9a-f-]{36})/product-journeys", value["args"][5])
    require(value["args"][0] == "electron/scripts/product-journey-shards.mjs" and value["args"][3] == "1" and
            local_run and host["localRunId"] == local_run[1] and
            host["phase"] == "host" and host["state"] == "host-admitted/private-pending" and
            host["uid"] == value["uid"] and host["gids"][0] == value["gid"] and
            all(binding[key] == qualification[other] for key, other in
                (("head", "head"), ("base", "base"), ("runId", "run"), ("attempt", "attempt"))) and
            pathlib.Path("/proc/self/cgroup").read_text() == host["memoryCgroup"],
            "native B same continuous Full owner invalid")
    require(not (file.parent / "failed.json").exists(), "native B failed host gate")
    return host


def private_resource_gate(checkout, root, value, host):
    # Read the actual host while still inside INITIAL setup. Never retain a
    # host descriptor/view or start a privileged Node/probe to learn admission.
    helper = exact_file(checkout, "scripts/local-ci-full-filesystems.py")
    require(hashlib.sha256(helper.read_bytes()).hexdigest() == value["qualification"]["source"]["scripts/local-ci-full-filesystems.py"],
            "native B resource helper changed")
    functions = runpy.run_path(str(helper))
    fresh = functions["inspect"](host["locations"], host["uid"], host["gids"])
    expected = {entry["label"]: entry["device"] for entry in host["filesystems"]}
    require(len(fresh) == len(expected) and all(expected[entry["label"]] == entry["device"] for entry in fresh),
            "native B host placement changed")
    devices = {}
    for entry in fresh:
        require(entry["allocationUnit"] == "4096", "native B host allocation geometry changed")
        available = [int(entry["bytes"]), int(entry["inodes"])]
        require({quota["type"] for quota in entry["quotas"]} == {0, 1, 2}, "native B host quota domain unknown")
        for quota in entry["quotas"]:
            require(quota["state"] in ("kernel-disabled", "kernel-enabled"), "native B host quota unknown")
            if quota["state"] == "kernel-enabled":
                for index, key in enumerate(("bytes", "inodes")):
                    if quota[key] is not None:
                        available[index] = min(available[index], int(quota[key]))
        prior = devices.setdefault(entry["device"], available)
        devices[entry["device"]] = [min(a, b) for a, b in zip(prior, available)]
    require(set(devices) == {entry["device"] for entry in host["report"]}, "native B host device set changed")
    for entry in host["report"]:
        available = devices[entry["device"]]
        require(available[0] > int(entry["demandBytes"]) and available[1] > int(entry["demandInodes"]),
                "native B fresh complete host filesystem/quota risk exceeds headroom")
    memory_facts = functions["inspect_memory"](host["memoryCgroup"])
    memory = functions["assess_memory"](memory_facts, host["memoryCgroup"], int(host["memory"]["demand"]))
    actual = functions["inspect"]([["native-b-root-1", str(root)]], host["uid"], [value["gid"]])[0]
    require(actual["mount"] == str(root) and actual["allocationUnit"] == "4096" and
            os.stat(root).st_dev != os.stat(root.parent).st_dev and
            all(quota["state"] == "kernel-disabled" for quota in actual["quotas"]),
            "native B actual private tmpfs geometry/quota unknown")
    require(int(actual["bytes"]) > int(host["privateDemand"]["bytes"]) and
            int(actual["inodes"]) > int(host["privateDemand"]["inodes"]),
            "native B actual private tmpfs risk exceeds remaining capacity/quota")
    require(not CLOSED, "native B private admission closed")
    # Keep source-shaped numeric facts in the owned host outcome, not the
    # small workload receipt. No host paths/routes/raw proc text is published.
    memory_evidence = dict(memory_facts)
    memory_evidence["membershipDigest"] = hashlib.sha256(memory_evidence.pop("membership").encode()).hexdigest()
    memory_evidence["ancestors"] = [{**{key: val for key, val in entry.items() if key != "path"}, "depth": index}
                                    for index, entry in enumerate(memory_facts["ancestors"])]
    return {"state": "private-accepted", "binding": host["binding"], "localRunId": host["localRunId"],
            "estimateDigest": host["estimateDigest"], "memory": memory,
            "root": {key: actual[key] for key in ("device", "bytes", "inodes", "allocationUnit", "quotas")},
            "observations": {"filesystems": fresh, "memory": memory_evidence},
            "hostFactsDigest": hashlib.sha256(json.dumps({"filesystems": fresh, "memory": memory_evidence}, sort_keys=True).encode()).hexdigest()}


def materialize_git(root, checkout, view, uid, gid):
    directory = private_path(root, str(checkout / ".git"))
    directory.mkdir(parents=True)
    (directory / "HEAD").write_text(view["head"] + "\n")
    (directory / "config").write_text("[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\n")
    ref = directory / "refs/remotes/origin/master"
    ref.parent.mkdir(parents=True)
    ref.write_text(view["base"] + "\n")
    # Attach the nonrecursive parent BEFORE child mounts. Binding it afterward
    # would cover index/objects/shallow with their empty underlying placeholders.
    mount(str(directory), str(directory), flags=MS_BIND)
    bind(root, str(exact_file(checkout, ".git/index")))
    bind(root, str(checkout / ".git/objects"))
    if (checkout / ".git/shallow").exists():
        bind(root, str(exact_file(checkout, ".git/shallow")))
    # Git's safe-directory check must observe the real ordinary owner, not a
    # safe.directory waiver. Keep the checkout and metadata non-writable.
    for target in (directory.parent, directory):
        os.chown(target, uid, gid)
        os.chmod(target, 0o555)
    # Remount only: freeze metadata without overlaying the readonly children.
    mount(None, str(directory), flags=MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV)


def write_json(file, value, uid, gid):
    with open(file, "x", encoding="utf-8") as stream:
        os.chmod(file, 0o600)
        os.chown(file, uid, gid)
        json.dump(value, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(pathlib.Path(file).parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def capabilities():
    return {line.split(":", 1)[0]: line.split(":", 1)[1].strip()
            for line in pathlib.Path("/proc/self/status").read_text().splitlines()
            if line.startswith(("Cap", "NoNewPrivs:"))}


def drop(uid, gid):
    # Drop every bounding bit supported by this kernel, not a versioned subset.
    last = int(pathlib.Path("/proc/sys/kernel/cap_last_cap").read_text())
    require(0 <= last < 64, "native B unsupported capability range")
    for cap in range(last + 1):
        require(LIBC.prctl(24, cap, 0, 0, 0) == 0, "native B bounding capability drop refused")
    require(LIBC.prctl(47, 4, 0, 0, 0) == 0, "native B ambient capability drop refused")
    os.setgroups([])
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32),
                    ("inheritable", ctypes.c_uint32)]
    require(LIBC.capset(ctypes.byref(Header(0x20080522, 0)), ctypes.byref((Data * 2)())) == 0,
            "native B capability clearing refused")
    facts = capabilities()
    require(all(int(facts[key], 16) == 0 for key in ("CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd")),
            "native B capabilities remain")
    require(facts["NoNewPrivs"] == "0", "native B sandbox-incompatible no-new-privileges")
    require(os.getresuid() == (uid, uid, uid) and os.getresgid() == (gid, gid, gid) and not os.getgroups(),
            "native B identity drop incomplete")
    return facts


def network_interfaces():
    return sorted(line.split(":", 1)[0].strip()
                  for line in pathlib.Path("/proc/net/dev").read_text().splitlines()[2:])


def proc_net_rows(name):
    # IPv6 may be disabled by the kernel; then neither table exists.
    table = pathlib.Path("/proc/net", name)
    return [line.split() for line in table.read_text().splitlines()] if table.exists() else []


def interface_ioctl(descriptor, command, payload):
    buffer = ctypes.create_string_buffer(payload, IFREQ_SIZE)
    require(LIBC.ioctl(descriptor, ctypes.c_ulong(command), buffer) == 0, "native B loopback ioctl refused")
    return buffer.raw


def loopback_facts():
    """Observe the fresh namespace's complete interface/address/route view."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        flags = struct.unpack(IFREQ, interface_ioctl(probe.fileno(), SIOCGIFFLAGS,
                                                     struct.pack(IFREQ, b"lo", 0)))[1]
        listing = ctypes.create_string_buffer(IFREQ_SIZE * 8)
        conf = IfConf(len(listing), ctypes.cast(listing, ctypes.c_void_p))
        require(LIBC.ioctl(probe.fileno(), ctypes.c_ulong(SIOCGIFCONF), ctypes.byref(conf)) == 0,
                "native B loopback address listing refused")
    # A full buffer may have truncated the listing; never accept it as complete.
    require(0 <= conf.length < len(listing) and conf.length % IFREQ_SIZE == 0,
            "native B loopback address listing incomplete")
    ipv4 = []
    for offset in range(0, conf.length, IFREQ_SIZE):
        name, family, _port, address = struct.unpack_from("16sHH4s", listing.raw, offset)
        require(family == socket.AF_INET, "native B loopback address family unknown")
        ipv4.append([name.rstrip(b"\0").decode("ascii"), socket.inet_ntoa(address)])
    ipv6 = [[fields[5], fields[0]] for fields in proc_net_rows("if_inet6")]
    # lo-up adds only local-table IPv4 routes; the main table stays empty.
    ipv4_routes = pathlib.Path("/proc/net/route").read_text().splitlines()[1:]
    ipv6_routes = [[fields[9], fields[1], int(fields[8], 16) & RTF_REJECT != 0]
                   for fields in proc_net_rows("ipv6_route")]
    return {"interfaces": network_interfaces(), "up": flags & IFF_UP != 0,
            "ipv4": sorted(ipv4), "ipv6": sorted(ipv6), "ipv4MainRoutes": len(ipv4_routes),
            "ipv6Routes": ipv6_routes}


def admissible_loopback(facts):
    return (facts["interfaces"] == ["lo"] and facts["up"] and facts["ipv4"] == [["lo", "127.0.0.1"]] and
            facts["ipv6"] in ([], [["lo", "0" * 31 + "1"]]) and facts["ipv4MainRoutes"] == 0 and
            all(device == "lo" and (prefix != "00" or reject) for device, prefix, reject in facts["ipv6Routes"]))


def private_loopback():
    # B-debugger-private-loopback-v1: Playwright's Electron launcher reaches the
    # inspector/DevTools over local TCP, so this fresh private namespace's own lo
    # is brought up once, before chroot and the permanent privilege drop. No
    # other interface, address, route or host network state is touched.
    before = loopback_facts()
    require(before["interfaces"] == ["lo"] and not before["up"] and not before["ipv4"] and
            not before["ipv6"] and before["ipv4MainRoutes"] == 0, "native B loopback namespace not fresh")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        interface_ioctl(probe.fileno(), SIOCSIFFLAGS, struct.pack(IFREQ, b"lo", IFF_UP))
    after = loopback_facts()
    require(admissible_loopback(after), "native B loopback configuration unexpected")
    return {"version": "B-debugger-private-loopback-v1", "interfaces": after["interfaces"],
            "ipv4": after["ipv4"], "ipv6": after["ipv6"], "ipv4MainRoutes": after["ipv4MainRoutes"]}


def request():
    value = control_read(int(time.time() * 1000) + 10_000)
    require(set(value) == {"uid", "gid", "checkout", "node", "args", "environment", "hostNamespaces", "gitView", "qualification", "resourceAdmission"},
            "native B request fields invalid")
    require(type(value["uid"]) is int and value["uid"] > 0 and type(value["gid"]) is int and value["gid"] > 0,
            "native B ordinary identity required")
    checkout = pathlib.Path(value["checkout"])
    # This approved helper never supports local privilege checks or arbitrary roots.
    require(checkout.is_absolute() and str(checkout).startswith("/home/runner/work/") and
            checkout.resolve(strict=True) == checkout, "native B checkout is not the admitted GitHub path")
    require(pathlib.Path(value["node"]).is_absolute(), "native B node path invalid")
    args = value["args"]
    require(isinstance(args, list) and all(isinstance(arg, str) and "\0" not in arg for arg in args),
            "native B argv invalid")
    journey_paths(args)
    env = value["environment"]
    require(isinstance(env, dict) and all(isinstance(k, str) and isinstance(v, str) and "\0" not in v for k, v in env.items()),
            "native B environment invalid")
    require(set(env) <= {"LANG", "TZ", "CI", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GRIMODEX_PRODUCT_JOURNEY_IDS", "GRIMODEX_PRODUCT_JOURNEY_CATALOG_DIGEST",
                         "GRIMODEX_PRODUCT_JOURNEY_BUILD_RECEIPT", "GRIMODEX_C2ZC_RUST_RECEIPT_PATH",
                         "GRIMODEX_C2ZC_RUST_RECEIPT_SHA256", "GRIMODEX_C2ZC_RUST_REQUESTED_BASE",
                         "GRIMODEX_C2ZC_RUST_REQUESTED_HEAD", "GRIMODEX_C2ZC_RESTORE_FIXTURE"},
            "native B environment selector not admitted")
    includes_editor = (args[3] == "1" if args[0].endswith("shards.mjs") else
                       "editor-persistence" in json.loads(env["GRIMODEX_PRODUCT_JOURNEY_IDS"])
                       if env.get("GRIMODEX_PRODUCT_JOURNEY_IDS") else True)
    qualification = value["qualification"]
    require(includes_editor and qualification is not None, "native B setup only admits the Editor consumer with qualification")
    if qualification is not None:
        require(isinstance(qualification, dict) and set(qualification) ==
                {"intentDigest", "identities", "source", "head", "base", "run", "attempt", "routes"},
                "native B qualification binding invalid")
        require(re.fullmatch(r"[0-9a-f]{64}", qualification["intentDigest"]) and
                qualification["head"] == value["gitView"]["head"] and qualification["base"] == value["gitView"]["base"] and
                qualification["run"] == env.get("GITHUB_RUN_ID") and qualification["attempt"] == env.get("GITHUB_RUN_ATTEMPT") and
                all(re.fullmatch(r"[1-9][0-9]*", qualification[key]) for key in ("run", "attempt")),
                "native B qualification attempt invalid")
    return value


def stop(_signal, _frame):
    global CLOSED
    CLOSED = True


def descendants():
    # This /proc was mounted in our fresh PID namespace. Never inspect host PIDs.
    return [int(entry.name) for entry in pathlib.Path("/proc").iterdir() if entry.name.isdigit() and int(entry.name) > 1]


def reap():
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return
        yield pid, status


def escape_probe():
    # Actual setsid plus double fork. The final child retains both workload
    # pipes until PID1 retires/reaps it; process-group exit cannot pass this.
    require(os.setsid() is None, "native B setsid failed")
    read, write = os.pipe()
    middle = os.fork()
    if middle == 0:
        final = os.fork()
        if final:
            os._exit(0)
        os.close(read)
        os.write(1, b"native-b-escape-ready\n")
        os.write(write, b"1")
        os.close(write)
        while True:
            signal.pause()
    os.close(write)
    require(os.read(read, 1) == b"1", "native B escape admission unobserved")
    os.close(read)
    joined, status = os.waitpid(middle, 0)
    require(joined == middle and os.waitstatus_to_exitcode(status) == 0, "native B intermediate join failed")
    return 0


def qualify_routes(routes):
    require(isinstance(routes, dict) and set(routes) == {"pathname", "abstract", "tcp", "file"} and
            re.fullmatch(r"/tmp/grimodex-b-routes-[^/]+/system-desktop-secret", routes["pathname"]) and
            routes["file"] == str(pathlib.Path(routes["pathname"]).parent / "host-only") and
            re.fullmatch("\x00grimodex-b-[0-9a-f]{32}", routes["abstract"]) and
            type(routes["tcp"]) is int and 0 < routes["tcp"] < 65536,
            "native B sentinel identity invalid")
    require(not pathlib.Path(routes["file"]).exists() and
            not any(pathlib.Path(name).exists() for name in
                    ("/run/dbus/system_bus_socket", "/run/user", "/root", "/sys")),
            "native B forbidden host view visible")
    require((os.stat("/proc/1/root").st_ino, os.stat("/proc/1/root").st_dev) ==
            (os.stat("/").st_ino, os.stat("/").st_dev), "native B PID1 root alias invalid")
    for descriptor in os.listdir("/proc/self/fd"):
        if int(descriptor) <= 2:
            continue
        try:
            os.fstat(int(descriptor))
        except OSError as error:
            require(error.errno == errno.EBADF, "native B descriptor audit unknown")
        else:
            raise RuntimeError("native B inherited host descriptor remains")
    for family, address in ((socket.AF_UNIX, routes["pathname"]),
                            (socket.AF_UNIX, routes["abstract"]),
                            (socket.AF_INET, ("127.0.0.1", routes["tcp"]))):
        require(not CLOSED, "native B route admission closed")
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(0.5)
            try:
                client.connect(address)
            except OSError as error:
                require(error.errno in (errno.ENOENT, errno.ECONNREFUSED, errno.ENETUNREACH, errno.EHOSTUNREACH),
                        "native B route denial unknown")
            else:
                raise RuntimeError("native B owned host route escaped")
    require(not descendants(), "native B unexpected pre-workload descendant")
    return {"pathnameDenied": True, "abstractDenied": True, "tcpDenied": True, "hostViewDenied": True}


def supervise(node, args, environment, checkout, *, probe=False):
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    pipes = [os.pipe() for _ in range(2)]
    require(not CLOSED, "native B admission closed")
    pid = os.fork()
    if pid == 0:
        try:
            if CLOSED:
                os._exit(125)
            os.dup2(os.open("/dev/null", os.O_RDONLY), 0)
            for number, (read, write) in enumerate(pipes, 1):
                os.dup2(write, number)
            os.closerange(3, os.sysconf("SC_OPEN_MAX"))
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, signal.SIG_DFL)
            if probe:
                os._exit(escape_probe())
            os.chdir(checkout)
            os.execve(node, [node, str(pathlib.Path(checkout) / "scripts/local-ci-xvfb.mjs"), node, *args], environment)
        except BaseException:
            os._exit(125)
    for read, write in pipes:
        os.close(write)
        os.set_blocking(read, False)
    streams = {read: number for number, (read, _) in enumerate(pipes, 1)}
    status = None
    retiring = None
    started = time.monotonic()
    probe_bytes = bytearray()
    probe_joins = []
    while True:
        for child, result in reap():
            result = os.waitstatus_to_exitcode(result)
            if probe:
                probe_joins.append(result)
            if child == pid:
                status = result
        if probe and time.monotonic() - started > 5 and status is None:
            retiring = retiring or time.monotonic()
        if CLOSED or status is not None or retiring is not None:
            if retiring is None:
                retiring = time.monotonic()
            for child in descendants():
                try:
                    os.kill(child, signal.SIGTERM if time.monotonic() - retiring < 0.5 else signal.SIGKILL)
                except ProcessLookupError:
                    pass
        for descriptor in select.select(list(streams), [], [], 0.02)[0]:
            data = os.read(descriptor, 65536)
            if not data:
                os.close(descriptor)
                del streams[descriptor]
            elif probe:
                probe_bytes.extend(data)
                require(len(probe_bytes) <= 128, "native B escape output overflow")
            else:
                remaining = memoryview(data)
                while remaining:
                    remaining = remaining[os.write(streams[descriptor], remaining):]
        if status is not None and not descendants() and not streams:
            if probe:
                require(not CLOSED and status == 0 and probe_bytes == b"native-b-escape-ready\n" and
                        len(probe_joins) == 2 and sorted(probe_joins) in ([-15, 0], [-9, 0]),
                        "native B escape exit/EOF/all joins failed")
                return {"setsidDoubleFork": True, "reaped": 2, "stdoutEOF": True, "stderrEOF": True, "descendantsAbsent": True}
            return 1 if CLOSED or status < 0 else status
        if retiring is not None and time.monotonic() - retiring > 5:
            # Unknown exit/EOF remains owned. Outer task deadline can destroy this
            # PID namespace; it must still observe launcher close/EOF/all joins.
            while True:
                time.sleep(1)


def control_read(deadline):
    require(not CLOSED and time.time() * 1000 < deadline, "native B setup admission closed/expired")
    # One bounded initial request only; EOF/cancellation never admits setup.
    data = bytearray()
    while not data.endswith(b"\n"):
        require(not CLOSED and time.time() * 1000 < deadline, "native B setup admission closed/expired")
        if not select.select([0], [], [], 0.05)[0]:
            continue
        chunk = os.read(0, 1)
        require(chunk and len(data) < 1024 * 1024, "native B setup request closed/overflow")
        data.extend(chunk)
    return json.loads(data)


def private_transport(descriptor):
    mode = os.fstat(descriptor).st_mode
    if stat.S_ISFIFO(mode):
        return True
    if not stat.S_ISSOCK(mode):
        return False
    # Node's existing stdio='pipe' uses anonymous Unix socketpairs on Linux.
    # Only that unnamed, non-listening transport is admissible, never a host
    # pathname/abstract socket, file, namespace FD or inherited listener.
    with socket.socket(fileno=os.dup(descriptor)) as endpoint:
        return (endpoint.family == socket.AF_UNIX and endpoint.type == socket.SOCK_STREAM and
                endpoint.getsockname() == "" and endpoint.getpeername() == "" and
                endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 0)


def main():
    require(os.getuid() == 0 and os.getpid() == 1 and len(sys.argv) == 1, "native B requires the fixed namespace initializer")
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    # The only initial request is bounded and consumed before any setup.
    value = request()
    require(not CLOSED, "native B admission closed")
    namespace_names = ("mnt", "net", "pid", "ipc")
    current = {name: os.readlink("/proc/self/ns/" + name) for name in namespace_names}
    require(set(value["hostNamespaces"]) == set(namespace_names) and
            all(current[name] != value["hostNamespaces"][name] for name in namespace_names),
            "native B namespace separation absent")
    # sysfs keeps listing its mounter's (host) devices; /proc/net is per reader.
    require(network_interfaces() == ["lo"], "native B unexpected network interface")
    loopback = private_loopback()
    mount(None, "/", flags=MS_REC | MS_PRIVATE)
    uid, gid = value["uid"], value["gid"]
    checkout = pathlib.Path(value["checkout"])
    root_marker, shard_output = journey_paths(value["args"])
    tracked = git_sources(checkout, value["gitView"])
    evidence = evidence_sources(checkout, value["environment"])
    host = resource_owner(checkout, value)
    workspaces, workspace_links = workspace_sources(checkout)
    root = owned_directory(checkout, root_marker, uid, gid)
    mount("tmpfs", str(root), "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755")
    admitted = [checkout / name for name in CHECKOUT if (checkout / name).exists()] + workspaces
    for source in RUNTIME:
        entry = pathlib.Path(source)
        if entry.is_symlink():
            private_path(root, source).symlink_to(os.readlink(source))
        elif entry.exists():
            bind(root, source)
    for source in admitted:
        audit_checkout(source, admitted, workspace_links)
        bind(root, str(source))
    # Complete the live tracked checkout, not just runtime directories. Bind
    # individual files outside those trees (including tracked .gitignore and
    # public .npmrc), never their potentially secret/output-bearing parents.
    for source in tracked + evidence:
        if not any(source == base or base in source.parents for base in admitted):
            bind(root, str(source))
    materialize_git(root, checkout, value["gitView"], uid, gid)
    # Mount only the runtime executable, never its toolcache/home parent tree.
    node = str(pathlib.Path(value["node"]).resolve(strict=True))
    if not node.startswith("/usr/"):
        bind(root, node)
    for source in ("/etc/ld.so.cache", "/etc/fonts"):
        if pathlib.Path(source).exists():
            bind(root, source)
    for directory, mode in (("/tmp", 0o1777), ("/run", 0o755), ("/dev", 0o755),
                            ("/dev/shm", 0o1777), ("/proc", 0o755), ("/home/runner", 0o700),
                            ("/run/grimodex-native-b", 0o700)):
        destination = private_path(root, directory)
        destination.mkdir(parents=True, exist_ok=True)
        os.chmod(destination, mode)
        if directory in ("/home/runner", "/run/grimodex-native-b"):
            os.chown(destination, uid, gid)
    for name in ("null", "zero", "random", "urandom"):
        source = "/dev/" + name
        target = private_path(root, source)
        target.touch()
        mount(source, str(target), flags=MS_BIND)
    private_path(root, "/dev/fd").symlink_to("/proc/self/fd")
    etc = private_path(root, "/etc")
    etc.mkdir(exist_ok=True)
    (etc / "passwd").write_text(f"runner:x:{uid}:{gid}:synthetic:/home/runner:/bin/false\n")
    (etc / "group").write_text(f"runner:x:{gid}:\n")
    (etc / "nsswitch.conf").write_text("passwd: files\ngroup: files\nhosts: files\n")
    mount("proc", str(root / "proc"), "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC)
    # Output layout stays canonical; no borrowed artifact/log tree is exposed.
    if shard_output is not None:
        # Only this shard's canonical leaf is visible/writable. Binding the
        # common output would expose active siblings and reject later shards.
        output = owned_directory(checkout, shard_output, uid, gid)
        bind(root, str(output), readonly=False)
    require(shard_output is not None, "native B requires canonical resource outcome placement")
    try:
        resources = private_resource_gate(checkout, root, value, host)
    except BaseException:
        write_json(str(checkout / shard_output / "native-resource-admission.json"),
                   {"state": "failed", "phase": "private", "binding": host["binding"],
                    "localRunId": host["localRunId"], "estimateDigest": host["estimateDigest"]}, uid, gid)
        raise
    os.chdir(root)
    os.chroot(".")
    os.chdir("/")
    # Only pipe transport reaches PID1. Files, sockets and namespace descriptors
    # (including host log files) must not cross this boundary.
    for descriptor in (0, 1, 2):
        require(private_transport(descriptor), "native B inherited non-private-transport descriptor")
    os.close(0)
    os.closerange(3, os.sysconf("SC_OPEN_MAX"))
    facts = drop(uid, gid)
    resources["namespaces"] = current
    resources["root"]["inode"] = os.stat("/").st_ino
    require(not CLOSED, "native B resource outcome admission closed")
    write_json(str(checkout / shard_output / "native-resource-admission.json"), resources, uid, gid)
    qualification = value["qualification"]
    if qualification:
        routes = qualify_routes(qualification["routes"])
        escape = supervise(None, None, None, None, probe=True)
        qualification = {key: qualification[key] for key in ("intentDigest", "identities", "source", "head", "base", "run", "attempt")}
        qualification.update(routes=routes, retirement=escape)
    require(not CLOSED, "native B workload admission closed")
    write_json(RECEIPT, {"version": "B-native-privileged-setup-v1", "uid": uid, "gid": gid,
                         "namespaces": current, "hostNamespaces": value["hostNamespaces"], "qualification": qualification,
                         "capabilities": facts, "loopback": loopback, "resources": {"state": resources["state"],
                         "estimateDigest": resources["estimateDigest"], "localRunId": resources["localRunId"]},
                         "root": os.stat("/").st_ino,
                         "rootDevice": os.stat("/").st_dev}, uid, gid)
    environment = dict(value["environment"], PATH=str(pathlib.Path(node).parent) + ":/usr/bin:/bin",
                       HOME="/home/runner", XDG_RUNTIME_DIR="/run/grimodex-native-b", TMPDIR="/tmp")
    os.environ.clear()
    return supervise(node, value["args"], environment, str(checkout))


def client_boundary():
    record = json.loads(pathlib.Path(RECEIPT).read_text())
    require(record.get("resources", {}).get("state") == "private-accepted", "native B client private gate absent")
    require(record["version"] == "B-native-privileged-setup-v1" and record["qualification"] and
            os.getresuid() == (record["uid"],) * 3 and os.getresgid() == (record["gid"],) * 3 and not os.getgroups() and
            os.stat("/").st_ino == record["root"] and os.stat("/").st_dev == record["rootDevice"] and
            all(os.readlink("/proc/self/ns/" + name) == value for name, value in record["namespaces"].items()) and
            capabilities() == record["capabilities"], "native B client boundary invalid")
    return record


def fixed_client(executable, args):
    # Installed trusted fixed binary only; no shell/general command interface.
    with subprocess.Popen([executable, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin", "HOME": "/home/runner", "TMPDIR": "/tmp"}) as child:
        try:
            stdout, stderr = child.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate(timeout=2)
            raise RuntimeError("native B client timeout; qualification failed")
        require(len(stdout) + len(stderr) <= 8192, "native B client output overflow")
        return child.returncode, stdout, stderr


def qualify_bus(mode):
    record = client_boundary()
    if mode == "--cancel-client":
        # Real pending-start client: no endpoint is supplied before this barrier.
        # Parent closes admission, signals us, then runs its delayed input path.
        def cancelled(_signal, _frame):
            print("cancelled-before-input", flush=True)
            sys.exit(0)
        signal.signal(signal.SIGTERM, cancelled)
        print("ready-for-input", flush=True)
        sys.stdin.buffer.read(4097)
        raise RuntimeError("native B late cancelled client admitted")
    data = sys.stdin.buffer.read(4097)
    require(len(data) <= 4096, "native B client request overflow")
    request = json.loads(data)
    require(set(request) == {"address", "config", "configDigest", "intentDigest"} and
            request["intentDigest"] == record["qualification"]["intentDigest"], "native B client owner invalid")
    config = pathlib.Path(request["config"])
    require(config.parent.parent == pathlib.Path("/tmp") and config.parent.name.startswith("grimodex-native-b-bus-") and
            not config.is_symlink() and config.stat().st_uid == os.getuid() and stat.S_IMODE(config.stat().st_mode) == 0o600 and
            hashlib.sha256(config.read_bytes()).hexdigest() == request["configDigest"], "native B client config invalid")
    daemon_hash = hashlib.sha256(pathlib.Path("/usr/bin/dbus-daemon").read_bytes()).hexdigest()
    require(daemon_hash == record["qualification"]["identities"]["daemon"]["sha256"], "native B daemon changed")
    if mode == "--reject-config":
        require(config.read_bytes() == b"<busconfig><auth>EXTERNAL</auth></broken>\n" and request["address"] is None,
                "native B malformed config test invalid")
        code, stdout, stderr = fixed_client("/usr/bin/dbus-daemon", ["--nofork", "--config-file=" + str(config)])
        require(code == 1 and not stdout and (b"mismatched tag" in stderr or b"not well-formed" in stderr),
                "native B malformed config not rejected")
        print(json.dumps({"malformedConfigDenied": True}))
        return 0
    require(mode == "--qualify-bus", "native B client mode invalid")
    address = request["address"]
    require(isinstance(address, str) and re.fullmatch(r"unix:path=/tmp/grimodex-native-b-bus-[^/,;\s]+/bus,guid=[0-9a-f]{32}", address),
            "native B private address invalid")
    socket_path = address.split(",guid=", 1)[0][len("unix:path="):]
    require(pathlib.Path(socket_path).parent == config.parent, "native B socket/config owner mismatch")
    def auth_denied(mechanism, identity):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.settimeout(1)
            peer.connect(socket_path)
            peer.sendall(b"\0AUTH " + mechanism + b" " + identity + b"\r\n")
            response = bytearray()
            while not response.endswith(b"\r\n"):
                chunk = peer.recv(256)
                require(chunk and len(response) + len(chunk) <= 256, "native B auth response invalid")
                response.extend(chunk)
            require(response == b"REJECTED EXTERNAL\r\n", "native B unauthorized identity admitted")
    auth_denied(b"ANONYMOUS", b"synthetic".hex().encode())
    auth_denied(b"EXTERNAL", str(os.getuid() + 1).encode().hex().encode())
    require(hashlib.sha256(pathlib.Path("/usr/bin/dbus-send").read_bytes()).hexdigest() ==
            record["qualification"]["identities"]["client"]["sha256"], "native B client binary changed")
    def call(destination, method, *args):
        return fixed_client("/usr/bin/dbus-send", ["--bus=" + address, "--type=method_call", "--print-reply",
                            "--reply-timeout=1000", "--dest=" + destination, "/org/freedesktop/DBus", method, *args])
    code, stdout, stderr = call("org.freedesktop.DBus", "org.freedesktop.DBus.GetId")
    require(code == 0 and not stderr and re.search(rb'string "[0-9a-f]{32}"', stdout), "native B EXTERNAL driver call failed")
    for destination, method, args in (
            ("org.freedesktop.DBus", "org.freedesktop.DBus.RequestName", ("string:org.grimodex.BForbidden", "uint32:0")),
            ("org.freedesktop.DBus", "org.freedesktop.DBus.StartServiceByName", ("string:org.grimodex.BForbidden", "uint32:0")),
            ("org.freedesktop.DBus", "org.freedesktop.DBus.Peer.Ping", ())):
        code, stdout, stderr = call(destination, method, *args)
        require(code != 0 and b"org.freedesktop.DBus.Error.AccessDenied" in stdout + stderr,
                "native B forbidden ownership/activation/destination not denied")
    code, stdout, stderr = call("org.freedesktop.DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.secrets")
    require(code == 0 and not stderr and b"boolean false" in stdout, "native B forbidden service owned")
    code, stdout, stderr = call("org.freedesktop.secrets", "org.freedesktop.DBus.Peer.Ping")
    require(code != 0 and any(error in stdout + stderr for error in
            (b"org.freedesktop.DBus.Error.AccessDenied", b"org.freedesktop.DBus.Error.ServiceUnknown")),
            "native B forbidden destination reachable")
    print(json.dumps({"external": True, "anonymousDenied": True, "spoofDenied": True,
                      "ownershipDenied": True, "activationDenied": True, "destinationDenied": True}))
    return 0


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 1 or sys.argv[1:] in (["--qualify-bus"], ["--reject-config"], ["--cancel-client"]),
                "native B invocation invalid")
        sys.exit(main() if len(sys.argv) == 1 else qualify_bus(sys.argv[1]))
    except Exception:
        # Never print transport paths, inherited env/argv or exception payloads.
        print("native B setup/admission failed; no fallback", file=sys.stderr)
        sys.exit(1)
