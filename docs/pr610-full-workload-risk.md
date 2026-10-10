# PR610 finite Full workload sizing proposal

This is reviewed-risk **input**, not a capacity/admission receipt, historical peak,
all-future certificate, B grant, gate pass or merge readiness. The fixed dataset
uses the existing full-workload-allocation/1 producer with all68 tasks/default12.
Current source hashes and every actual preparation tuple are bound at ingestion.

## Direct references (run/attempt, artifact, SHA256)

- 38011068810/1 (8ecaf42e1e3565528ddacdd830d77d6f872232e1, tree c25bda467858685adab705b4dbf6d9c7bb1fdf7d); artifact 11653044584, sha256:7f4577d2d0762be5ac61f8fc2c2f1f1bfd5f9a2a51c49507cad3ca4081b94966; shaped setup-reference 4642ed6fb3e20a6f24af1e3bba4e78ac2e953b2996335a399bf05df8d0d0684f. Scope: Actual normal setup/materialization/JavaScript compiler and complete private-child-log observations only. Not a complete Full forecast/admission or all-future physical certificate.
- 38007676893/1 (46db21901934cc54641032545fcaaa1800d01594, tree 31b406f8e877f2117e614e43df40d9701cf0ee42); artifact 11651489523, sha256:d13791c9269dce08137b89a3e029597c08e13446d308fb314dea5973b36c2ce8; shaped setup-reference 01bf1fcd8f34e2fe32f1ab93101212a26e60f762a222fea3dcff3149f8a73303. Scope: Actual grouped pure-DB cold dependency/compiler/official-backup/failure and complete private-log observations only. Not a complete Full forecast, admission, gate receipt or all-future physical certificate.
- 38017460514/1 (fd44fa91ae66f8ed3e8f1cfe0d817f96888ed50d, tree d4eff9535875480720fbbbed7422863d8f3d7b64); artifact 11656024523, sha256:da7217378747dfdc21c9aaefb3e8626eba26639e4582c775460617174ae2df99; shaped setup-reference fb476ceaf128ba32f23d49ebe699bbed97a317e6145bf0eff2dcfa1bd76b315c. Scope: Actual locked CPU environment/cache and complete private-child-log observations only. Pinned tool's historical action extraction/logs, other workloads and future capacity are unobserved; not Full admission or an all-future bound.
- 38023515626/1 (a54de3448e722ca67ee62f0dc2b3056430a6f130, tree e7d19de70515fbbb9c21b62d46f6259f5c69d534); artifact 11659471726, sha256:7a5de3def35d57d3c88e1fb9d3423b5546cf0025e23c77e027941d82818062a3; shaped setup-reference 557a40d477053c09233fa88808459cb5500bd2dbf949fa8100c06371139e02d5. Scope: Actual default-feature release native target (including UniDic generated/extracted inputs), ORT cache, registry/git caches, published .node and complete private-child-log metadata. Not a peak, complete Full forecast/admission or all-future bound.
- APT38000600715/1, artifact11649780162/sha256:380b3600cd5a03212e5e43bc666c930ecf60c7a0b56c5dc27c894a83f961fbfe; exact201-package solver/metadata reference97fd9e7d47d3592bc215e3546c5a33d6e9ea874ac8a384353a7f26d1d680298a. Archive169859242B and Installed-Size677114880B are **not physical observations**.
- Stable Rust toolchain/shims: accepted contracts37986282307/1 artifact11642509826/sha256:f76891e7fe32463e9a5890d95d63b0c47418492e0c00d0bd0d11b04eea140823; installed metadata0816349b1689bc4e9b0014858724ce80173deaca5e948b8203d48d39d960eaac. Scoped retained reference only.

## Arithmetic and explicit assumptions

- The declared allocation scenario is4KiB data rounding and one independent inode
  per enumerated path. For enhanced roots reserve max(observed blocks, logical
  bytes PER PATH +4096*path count), round up; never sparse logical bytes as
  observed blocks. Nested uv environment/fixture children are excluded. No
  cross-run/device union sum, union-plus-component sum, symlink traversal or
  cross-root hardlink saving. Future allocation geometry must be assessed
  before use; these are forecast assumptions, not filesystem attestations.
- Retained native target4433014784B/4910inodes and
  output288808960B/1inode are no-sharing scenarios
  derived from native38023515626/1, not peaks. Required ORT root is observed;
  optional missing git cache remains null in the source observation. No zero
  cache assumption is borrowed: Cargo dependency growth uses separate native
  and DB registry images, plus additional compiler-profile images.
- Download/extraction/staged replacement images coexist with retained outputs.
  Node scratch is RUNNER_TEMP then tool-cache copy; cache tar restores to final
  store directly and is NOT a second expanded restored store. Bootstrap v3
  and installed v10 are distinct configured siblings, not aliases. Old installer
  umbrella is never subtracted or summed with its nested store.
- Rust stable/Node22 and APT resolution float: additional whole prior/current
  payload images are explicit additive uncertainty, not a percentage or a
  claim future versions cannot grow beyond this scenario. Rust old per-root
  geometry is assumed compatible; whole-image version reserve remains.
  The same additive5494403072B/719022inode mutable-image scenario is split
  by actual destination: Node220393472B/5866inodes at tool-cache,
  Rust647225344B/189inodes at rustup-home, system3385577472B/661446inodes
  at root, and store1241206784B/51521inodes at pnpm-store. These are separate
  uncertainty inventories, not another combined image charged to tool-cache;
  aliased devices sum them once while disjoint devices cannot borrow capacity.
- System physical forecast uses a maximal small-file-density scenario: one
  independent inode and allocation rounding block per Installed-Size KiB,
  plus per-package directories, logical KiB payload and a distinct unpacked
  replacement image. It assumes Debian Installed-Size accounts at least one
  KiB per member, including nonregular members. This assumption is not a
  measured file catalogue; archive lengths are used only for separate rounded
  archive cache files, never as expanded allocation bounds. A complete dense
  additional system image covers maintainer-script/config/cache/index growth.
- Browser **system** dependencies and cargo-audit have no acquired physical
  roots. They use named technical cross-consumer envelopes, not invented
  observations: browser library/font delta adds the full expanded Chromium
  image to the dense canonical-system image; audit has the full native-output
  binary image, independent native+DB registry images and complete native-target
  compiler scratch. These proxy assumptions need independent credibility
  review; they do not freeze the actual browser/audit dependency versions or
  claim native compilation measured audit. No installed-state saving is used.
- Shared/native licensing/check/test/doctest compilation reserves distinct
  observed native-graph and pure-DB target images per current recipe; linker
  scratch reserves one largest-native-output image per each of4 Cargo jobs.
  Additional distinct native+DB profile/incremental images are uncertainty.
  These are explicit cross-profile/code-generation scenarios, not target
  certificates or source/lockfile-size multipliers. Common dependency images are reserved once per
  distinct target/profile family, with a distinct top-level output image per
  additional Cargo tuple; this is explicit compatible cache-graph reuse, not
  cleanup or old capacity. These shared/native compilation recipes charge the
  workspace device: all four root/package Cargo metadata contexts must resolve
  exactly to `src-tauri/target` or `electron/native/grimodex-node/target` inside
  this checkout. Redirected metadata or symlinked existing ancestors reject;
  a canonical target on a disjoint mounted device also rejects at the first
  pre-spawn demand assessment, rather than receiving zero demand. Same-device
  target quota observations constrain the entire workspace aggregate through
  the existing per-device minimum, without charging aliased targets twice.
  No target path is rewritten and no disjoint device borrows workspace capacity.
  Additional global variant images are charged once
  for preparation and once for post-preparation uncertainty. Each tuple still
  has positive output/link/log/growth terms. The producer sums all simultaneous
  transient terms without serial/fail-fast cleanup savings. Real same-job observations can
  only raise residuals; overruns reject/cancel owned preparation, never retry.
- Fixture DB scenario starts from the acquired official schema DB. Each of
  the literal2/140 materials reserves one4KiB leaf page for each of
  21 Source/Codex table-index/proposal-payload surfaces; a revision
  separately reserves one page for each of93 narrative/qualification
  table-index objects and0/3 actual A3 scope refs. Grouped authority/schema
  objects are NOT multiplied by materials. This explicit density scenario is
  not SQLite page_count or100000 SQL steps as rows. Whole WAL
  images/frame headers,32KiB SHM regions, journals and construction images are
  separate. Producer owns7/3 pristine+input copies. Official backup, standalone
  and manifest remain positive and simultaneous. The full original C2-ZC
  construction inventory is charged to Node's os.tmpdir() (`node-temp`), as
  createC2ZcRestoreFixtureContext actually allocates it. Its retained original
  coexists with captureC2ZcRestoreFixtureEvidence's DB/backup/manifest copy at
  `workspace`; only those three roles are copied, and staged publication is a
  rename, not another copy. Distinct devices each need their own capacity;
  aliases sum these two distinct allocations once each. This intentionally broad
  page-density assumption is not a SQLite page_count observation.
- Each of33 journey cases reserves the whole case/restarts/owned workspaces,
  schema+Q512 mutation image, full desktop/renderer/log image as userData profile envelope,
  full renderer-assets/RGBA surface image as disk/GPU cache envelope, complete logs/receipts, additional workspace image,
  official failure backup/diagnostics and1920x1080 RGBA PNG scenario. Producer
  charges original tmpRoot AND whole artifact copy AND extra renderer.png.
  Extra full SQLite/WAL and userData/cache/failure images are independently
  reserved at worker temp, Node temp and artifacts. HiDPI/full-page, additional
  workspaces and repeated userData writes may exceed the finite scenario; no
  capture/upload/cleanup or mainClean contract is suppressed to make it fit.
- Complete uncapped logs are forecast as one full checked-in textual corpus
  image per stdout/stderr plus accepted complete child-log allocation and
  report; a second entire diagnostic image is explicit error-output uncertainty.
  Source text is used as a **log content scenario**, NEVER a compiler/payload
  coefficient. Future repetitive output remains uncapped and can exceed the
  forecast; retaining it is mandatory, not a runtime log cap.

## Acceptance and remaining boundary

Every named proxy, topology and uncertainty assumption is open to independent
changed-unit P2 review. Completing the data shape does not establish forecast
credibility by itself. No required unknown is silently converted to an observed
zero. No fixed capacity/%/GB/inode threshold or free-capacity-as-demand is used.
Actual same continuously owned hosted runner destination geometry, writable
capacity/user-group-project quotas/root-home pressure/exclusion are separate.
Both Full fences remain. P2 clean freeze/B/ONEEditor/final High/current Quick and
adjacent verify/Full from stage1 and adjacent identical verify/readiness/approved
base expected-HEAD squash/first-parent and fetched master are still incomplete.

Local validation is source/metadata arithmetic only. Product helpers, setup,
quota probes, fixture generation, tests, app/bus/Editor and Full are NOTRUN here.
The affected hosted contracts must exercise the real producer after independent
review and a normal reviewed-path checkpoint. No accepted group is replayed.
