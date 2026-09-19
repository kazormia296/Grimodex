from pathlib import Path
import re
R=Path.cwd()
changed=set()
def edit(path,old,new,count=1):
 p=R/path;s=p.read_text();n=s.count(old)
 if n!=count: raise RuntimeError(f'{path}: expected {count}, got {n}: {old[:140]!r}')
 p.write_text(s.replace(old,new));changed.add(path)
def region(path,start,end,fn):
 p=R/path;s=p.read_text();a=s.index(start);b=s.index(end,a+len(start));p.write_text(s[:a]+fn(s[a:b])+s[b:]);changed.add(path)
def replace_once(s,old,new):
 assert s.count(old)==1,(old[:120],s.count(old));return s.replace(old,new)
ST='electron/native/grimodex-node/src/state.rs'
NL='electron/native/grimodex-node/src/lib.rs'
TS='electron/main/narrativeMaintenance.ts'
IC='electron/shared/ipcContract.ts'
IP='electron/main/ipc.ts'
# Quarantined connections remain unusable. Park only exact pending cleanup
# handles, without keeping an old DB Arc alive or blocking its replacement.
edit(ST,'    pending: Mutex<HashMap<String, MaintenanceWorkspaceBinding>>,','''    pending: Mutex<HashMap<String, MaintenanceWorkspaceBinding>>,
    quarantined: Mutex<HashMap<String, MaintenanceWorkspaceBinding>>,''')
edit(ST,'impl NarrativeMaintenancePreemptedRunRegistry {','''impl NarrativeMaintenancePreemptedRunRegistry {
    pub fn park_quarantined_binding(&self, binding: &MaintenanceWorkspaceBinding) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let mut quarantined = self.quarantined.lock().unwrap_or_else(|e| e.into_inner());
        let ids = pending.iter().filter(|(_, owner)| *owner == binding)
            .map(|(id, _)| id.clone()).collect::<Vec<_>>();
        for id in ids { if let Some(owner) = pending.remove(&id) { quarantined.insert(id, owner); } }
    }

    /// Called by the existing reopen owner after a healthy authority is live.
    /// Unrelated workspaces never acquire or discard these exact Run handles.
    pub fn restore_quarantined_binding(&self, binding: &MaintenanceWorkspaceBinding) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let mut quarantined = self.quarantined.lock().unwrap_or_else(|e| e.into_inner());
        let ids = quarantined.iter().filter(|(_, old)| old.authority_id == binding.authority_id && old.generation != binding.generation)
            .map(|(id, _)| id.clone()).collect::<Vec<_>>();
        for id in ids { quarantined.remove(&id); pending.insert(id, binding.clone()); }
    }
''')
# Retain the existing total bound across both operational states.
p=R/ST;s=p.read_text();a=s.index('impl NarrativeMaintenancePreemptedRunRegistry {');b=s.index('\n}',a)+2
part=s[a:b]
part=part.replace('pending.len() < MAX_PREEMPTED_MAINTENANCE_RUNS','pending.len() + self.quarantined.lock().unwrap_or_else(|e| e.into_inner()).len() < MAX_PREEMPTED_MAINTENANCE_RUNS')
assert 'self.quarantined.lock().unwrap_or_else(|e| e.into_inner()).len() < MAX_PREEMPTED_MAINTENANCE_RUNS' in part
s=s[:a]+part+s[b:];p.write_text(s)
edit(ST,'impl NarrativeMaintenanceAttemptRegistry {','''impl NarrativeMaintenanceAttemptRegistry {
    pub fn require_binding(&self, attempt_id: &str, binding: &MaintenanceWorkspaceBinding) -> anyhow::Result<()> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = state.get(attempt_id).ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_UNKNOWN: {attempt_id}"))?;
        anyhow::ensure!(entry.authority_id == binding.authority_id && entry.generation == binding.generation,
            "NEX_MAINTENANCE_ATTEMPT_BINDING_MISMATCH: manual operation belongs to another workspace");
        Ok(())
    }
''')
# A terminal attempt owns no running SQL. Its DB health is a separate guard.
region(NL,'impl Drop for NarrativeMaintenanceAttemptGuard {','\nfn deferred_narrative_maintenance_result',lambda s: replace_once(replace_once(s,
'                Ok(receipt) => {\n                    self.cleanup_reusable',
'                Ok(receipt) => {\n                    self.finalized = true;\n                    self.cleanup_reusable'),
'        if self.cleanup_reusable {','        if self.finalized {'))
edit(NL,'''/// The recovery gate is released only after the pinned connection proves
/// reusable; otherwise the attempt remains a fail-closed quarantine marker.''','''/// A proven terminal receipt releases execution ownership even on cleanup
/// failure. The Database remains quarantined and cannot admit further work;
/// the existing workspace opener can then replace, never reuse, that DB.''')
# These two public Native main-only entry points cannot admit an unhealthy DB.
for name,end in [('pub fn get_narrative_maintenance_workspace_binding','    #[napi]'),('pub async fn begin_narrative_maintenance_attempt','    ///')]:
 def add_health(s):
  # Find the active Database statement without assuming multiline layout.
  matches=list(re.finditer(r'let authority = active_database\(&state.ws\)(?:\s*\.map_err\([\s\S]*?\))?\?;',s))
  if not matches:
   print('HEALTH INSERT deferred to explicit scan:',name)
   return s
  m=matches[0]
  return s[:m.end()]+'''\n            if !authority.db().connection_reusable() {
                return Err(AppError::Anyhow(anyhow::anyhow!("NEX_MAINTENANCE_CONNECTION_UNUSABLE: reopen workspace before maintenance")));
            }
'''+s[m.end():]
 # begin uses AppError in its blocking closure; getter uses napi::Result below.
 if name.startswith('pub async'):
  region(NL,name,end,add_health)
region(NL,'pub async fn cancel_narrative_maintenance_attempt','    ///',lambda s: replace_once(s,
'        if receipt.cleanup.status == "clean" && receipt.connection_reusable {',
'        { // Terminal execution proof is distinct from connection reuse.'))
# Getter health check is intentionally simple and does not query SQLite.
region(NL,'pub fn get_narrative_maintenance_workspace_binding','    ///',lambda s: re.sub(
 r'(Ok\(authority\) => \{)',r'\1\n                if !authority.db().connection_reusable() { return Err(Error::from_reason("NEX_MAINTENANCE_CONNECTION_UNUSABLE: reopen workspace")); }',s,count=1))
# Keep failed-open recovery closed to work but not closed to a later reopen.
region(NL,'fn close_narrative_maintenance_for_workspace_swap','\n/// RAII fallback',lambda s: replace_once(s,
'''        // Admission is already closed, so no new owner can add another''',
'''        if !authority.db().connection_reusable() {
            state.narrative_maintenance_preempted_runs.park_quarantined_binding(&binding);
        }
        // Admission is already closed, so no new owner can add another'''))
region(NL,'fn reopen_narrative_maintenance_admission','\n/// A panic',lambda s: replace_once(s,
'''        Ok(authority) => Some(
            state
                .narrative_maintenance_recovery_gate
                .binding_for_authority(&narrative_authority_id(&authority)),
        ),''',
'''        Ok(authority) => {
            let binding = state.narrative_maintenance_recovery_gate
                .binding_for_authority(&narrative_authority_id(&authority));
            if authority.db().connection_reusable() {
                state.narrative_maintenance_preempted_runs.restore_quarantined_binding(&binding);
            }
            Some(binding)
        },'''))
# Bind the actual attempt stop to every inter-phase recovery SQL statement.
edit(NL,'''            let _maintenance_no_wait = authority
                .db()
                .enter_maintenance_connection_no_wait();''','''            let recovery_stop = attempt_guard.as_ref()
                .map(|guard| state.narrative_maintenance_attempts.stop_signal(&guard.attempt_id))
                .transpose()?.unwrap_or_else(|| Arc::new(std::sync::atomic::AtomicBool::new(false)));
            let _maintenance_no_wait = authority.db()
                .enter_maintenance_connection_no_wait_with_stop(recovery_stop);''')
# Single manual work, same Native guard, actual stop signal and final commit barrier.
manual=r'''
fn run_manual_narrative_maintenance(
    state: &Arc<AppState>, attempt_id: Option<String>, project_id: &str, verify: bool,
) -> std::result::Result<String, AppError> {
    let attempt_id = attempt_id.filter(|id| !id.trim().is_empty())
        .ok_or_else(|| AppError::Anyhow(anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_REQUIRED: manual maintenance must be owned by main")))?;
    let open_guard = state.ws.open_lock.try_lock()
        .map_err(|_| AppError::Anyhow(anyhow::anyhow!("WORKSPACE_SWITCHING: manual maintenance cannot start during workspace open")))?;
    let authority = active_database(&state.ws)?;
    anyhow::ensure!(authority.db().connection_reusable(), "NEX_MAINTENANCE_CONNECTION_UNUSABLE: reopen workspace before maintenance");
    let binding = narrative_maintenance_binding_for_authority(state, &authority);
    state.narrative_maintenance_attempts.require_binding(&attempt_id, &binding)?;
    let kind = if verify { "dependency-verify" } else { "semantic-index-rebuild" };
    let work_key = format!("narrative-maintenance:v1/{kind}/{project_id}/manual-review");
    state.narrative_maintenance_attempts.start(&attempt_id, [work_key.clone()])?;
    let mut guard = NarrativeMaintenanceAttemptGuard::new(Arc::clone(state), attempt_id.clone());
    guard.bind_authority(Arc::clone(&authority));
    drop(open_guard);
    state.narrative_maintenance_attempts.mark_work_started(&attempt_id, &work_key)?;
    // A manual operation has one known work. Closing discovery now preserves
    // its committed success when cancellation arrives after the final grant.
    guard.close_work_registration()?;
    let stop = state.narrative_maintenance_attempts.stop_signal(&attempt_id)?;
    let finalizing = state.narrative_maintenance_attempts.finalization_granted_signal(&attempt_id)?;
    let _recovery_owner = authority.db().enter_maintenance_connection_no_wait_with_stop(Arc::clone(&stop));
    let should_stop = || -> anyhow::Result<()> {
        anyhow::ensure!(!state.narrative_maintenance_attempts.stop_requested(&attempt_id)?, "NEX_MAINTENANCE_ATTEMPT_CANCELLED");
        Ok(())
    };
    let grant = |key: &str| -> anyhow::Result<()> {
        anyhow::ensure!(key == work_key && state.narrative_maintenance_attempts.grant_work_finalize(&attempt_id, key)?, "NEX_MAINTENANCE_ATTEMPT_CANCELLED");
        Ok(())
    };
    let no_work = |_work: &narrative_extraction::DesiredWork| Ok::<(), anyhow::Error>(());
    let defer = |run_id: &str| state.narrative_maintenance_preempted_runs.defer(run_id, &binding);
    let control = narrative_extraction::MaintenanceCycleControl {
        should_stop: &should_stop, stop_signal: Some(stop),
        finalization_granted_signal: Some(finalizing),
        grant_finalize: &grant, defer_preempted_run: &defer,
        register_work: &no_work, work_started: &no_work, work_completed: &no_work,
        work_noop_completed: &no_work, work_deferred: &no_work,
    };
    should_stop()?;
    for run_id in state.narrative_maintenance_preempted_runs.pending_for_binding(&binding) {
        if narrative_extraction::try_cancel_preempted_maintenance_run(authority.db(), &run_id, "manual maintenance exact cleanup retry")? {
            state.narrative_maintenance_preempted_runs.remove(&run_id);
        } else {
            return Err(AppError::Anyhow(anyhow::anyhow!("NEX_MAINTENANCE_CONNECTION_PREEMPTED: pending cleanup is busy")));
        }
    }
    let (wire, dispatched) = if verify {
        let outcome = narrative_extraction::run_dependency_verify_for_project_with_coordinates_and_control(
            authority.db(), project_id, None, Some(&control), &work_key)?;
        (serde_json::to_value(outcome).map_err(anyhow::Error::from)?, true)
    } else {
        match narrative_extraction::rebuild_narrative_derived_state_for_project_with_control(
            authority.db(), project_id, Some(&control), &work_key)? {
            RebuildDerivedStateOutcome::AlreadyRunning { run_id } => (serde_json::json!({"outcome":"alreadyRunning","runId":run_id}), false),
            RebuildDerivedStateOutcome::Ran { run_id, summary } => (serde_json::json!({
                "outcome":"ran", "runId":run_id,
                "consumersEvaluated":summary.consumers_evaluated, "edgesEvaluated":summary.edges_evaluated,
                "consumersSkippedUnresolvableScope":summary.consumers_skipped_unresolvable_scope,
                "edgesSkippedUnresolvableScope":summary.edges_skipped_unresolvable_scope,
            }), true),
        }
    };
    if dispatched { state.narrative_maintenance_attempts.mark_work_succeeded(&attempt_id, &work_key)?; }
    else { state.narrative_maintenance_attempts.mark_work_completed(&attempt_id, &work_key)?; }
    guard.mark_cleanup_clean(state)?;
    if !guard.finalize_success()? { return Err(AppError::Anyhow(anyhow::anyhow!("NEX_MAINTENANCE_ATTEMPT_CANCELLED"))); }
    Ok(serde_json::to_string(&wire).map_err(anyhow::Error::from)?)
}

'''
edit(NL,'fn deferred_narrative_maintenance_result(',manual+'fn deferred_narrative_maintenance_result(')
for name,dto,flag in [('verify_narrative_dependency_graph','VerifyNarrativeDependencyGraphPayload','true'),('rebuild_narrative_derived_state','RebuildNarrativeDerivedStatePayload','false')]:
 start='    pub async fn '+name+'('
 def change(s):
  a=s.index('    pub async fn ');close=s.index('\n    }',a)+6
  old=s[a:close]
  new=f'''    pub async fn {name}(
        &self, payload: serde_json::Value, attempt_id: Option<String>,
    ) -> Result<String> {{
        let state = Arc::clone(&self.state);
        run_blocking(move || {{
            let dto: {dto} = from_wire("payload", payload)?;
            run_manual_narrative_maintenance(&state, attempt_id, &dto.project_id, {flag})
        }}).await
    }}'''
  return s[:a]+new+s[close:]
 region(NL,start,'\n    ///',change)
# Main: adopt a *valid* terminal failure but keep reuse quarantined until a
# different healthy Native binding is returned by the existing reopen path.
edit(TS,'  let terminalReceiptFailure: Error | null = null;','''  let terminalReceiptFailure: Error | null = null;
  let connectionQuarantine: { binding: NarrativeMaintenanceWorkspaceBinding; error: Error } | null = null;
  let manualOperationPending = false;
  const clearReplacedConnectionQuarantine = (): void => {
    if (!connectionQuarantine) return;
    try {
      const binding = normalizeWorkspaceBinding(backend?.getNarrativeMaintenanceWorkspaceBinding?.());
      if (binding && (binding.authorityId !== connectionQuarantine.binding.authorityId || binding.generation !== connectionQuarantine.binding.generation)) {
        connectionQuarantine = null;
      }
    } catch { /* Old/unhealthy/unknown authority never reopens admission. */ }
  };''')
edit(TS,'    if (disposed || quiescing) return;','    if (disposed || quiescing || connectionQuarantine) return;')
edit(TS,'    if (disposed || quiescing || inFlight) return;','    if (disposed || quiescing || inFlight || connectionQuarantine) return;')
edit(TS,'''        try {
          assertReusableTerminalReceipt(parsedReceipt);
        } catch (error) {
          terminalReceiptFailure =
            error instanceof Error ? error : new Error(String(error));
          throw error;
        }
        nativeReceipt = activeAttemptController.adoptTerminalReceipt(''','''        nativeReceipt = activeAttemptController.adoptTerminalReceipt(''')
edit(TS,'''        nativeAttemptIds.delete(attemptId);
        terminalReceiptFailure = null;''','''        nativeAttemptIds.delete(attemptId);
        terminalReceiptFailure = null;
        if (parsedReceipt.cleanup.status !== "clean" || !parsedReceipt.connectionReusable) {
          connectionQuarantine = {
            binding: parsedReceipt.workspaceBinding,
            error: new Error("NEX_MAINTENANCE_CONNECTION_UNUSABLE: reopen workspace before maintenance"),
          };
          clearTimer();
          clearCoordinatorWait();
        }''')
edit(TS,'''          nativeReceiptAdopted = true;
          terminalReceiptFailure = null;
          if (parsedReceipt.state === "interrupted")''','''          nativeReceiptAdopted = true;
          terminalReceiptFailure = null;
          assertReusableTerminalReceipt(parsedReceipt);
          if (parsedReceipt.state === "interrupted")''')
edit(TS,'''        if (!activeWorkspaceSwitchOwners.delete(owner)) return;
        if (''','''        if (!activeWorkspaceSwitchOwners.delete(owner)) return;
        clearReplacedConnectionQuarantine();
        if (''')
edit(TS,'''          terminalReceiptFailure !== null ||
          activeWorkspaceSwitchOwners.size !== 0''','''          terminalReceiptFailure !== null ||
          connectionQuarantine !== null ||
          activeWorkspaceSwitchOwners.size !== 0''')
region(TS,'  const registerAttempt = async','  const settleAttempt',lambda s: replace_once(s,
'''  ): Promise<void> => {
    if (''','''  ): Promise<void> => {
    if (connectionQuarantine) throw connectionQuarantine.error;
    if ('''))
edit(TS,'''      await quiesceForWorkspaceSwitch();
      disposed = true;''','''      await quiesceForWorkspaceSwitch();
      if (connectionQuarantine) throw connectionQuarantine.error;
      disposed = true;''')
edit(TS,'export interface NarrativeMaintenanceScheduler {','''export interface NarrativeMaintenanceScheduler {
  /** Main-only manual operation; no lifecycle ID is accepted from renderer. */
  runManualOperation?<T>(projectId: string, operation: (attemptId: string) => Promise<T>): Promise<T>;''')
manual_ts=r'''
  const runManualOperation = async <T>(projectId: string, operation: (attemptId: string) => Promise<T>): Promise<T> => {
    requireWorkComponent(projectId, "projectId");
    if (disposed || quiescing || manualOperationPending) throw new Error("NEX_MAINTENANCE_ATTEMPT_ACTIVE: maintenance or workspace transition is active");
    if (connectionQuarantine) throw connectionQuarantine.error;
    if (typeof backend?.beginNarrativeMaintenanceAttempt !== "function" || typeof backend?.cancelNarrativeMaintenanceAttempt !== "function") {
      throw new Error("NEX_MAINTENANCE_ATTEMPT_REQUIRED: Native lifecycle is unavailable");
    }
    manualOperationPending = true;
    let lease: NarrativeMaintenanceQuiesceLease | undefined;
    let claimed: string[] = [];
    try {
      lease = await quiesceForWorkspaceSwitch();
      if (disposed || activeWorkspaceSwitchOwners.size !== 1 || connectionQuarantine) {
        throw new Error("NEX_MAINTENANCE_ATTEMPT_CANCELLED: workspace transition won before manual start");
      }
      const binding = captureWorkspaceBinding();
      if (!binding) throw new Error("NEX_MAINTENANCE_ATTEMPT_BINDING_MISSING");
      claimed = sharedCoordinator?.claimAvailable([projectId]) ?? [projectId];
      if (claimed.length !== 1) throw new Error("NEX_MAINTENANCE_ATTEMPT_ACTIVE: project is occupied");
      const attemptId = randomUUID();
      activeAttemptController.begin(attemptId, binding);
      retainAttemptOwner(attemptId);
      inFlight = true;
      noteMutation();
      const flight = (async (): Promise<T> => {
        try {
          await registerAttempt(attemptId, binding);
          if (disposed || activeWorkspaceSwitchOwners.size !== 1 || !nativeAttemptIds.has(attemptId)) {
            throw new Error("NEX_MAINTENANCE_ATTEMPT_CANCELLED: manual admission closed");
          }
          const value = await operation(attemptId);
          const receipt = await cancelAttemptById(attemptId, "closed");
          assertReusableTerminalReceipt(receipt);
          if (receipt.state !== "succeeded") throw new Error("NEX_MAINTENANCE_ATTEMPT_CANCELLED: manual operation did not complete");
          return value;
        } catch (error) {
          if (nativeAttemptIds.has(attemptId)) {
            try { await cancelAttemptById(attemptId, "closed"); }
            catch (receiptError) {
              terminalReceiptFailure = receiptError instanceof Error ? receiptError : new Error(String(receiptError));
            }
          }
          throw error;
        } finally {
          if (!nativeAttemptIds.has(attemptId)) {
            if (activeAttemptId === attemptId) activeAttemptId = null;
            releaseAttemptOwner(attemptId);
            nativeTerminalReceiptAttemptIds.delete(attemptId);
          }
          inFlight = false;
          noteMutation();
        }
      })();
      // A command rejection is not a terminal-proof failure. Quiesce waits
      // for the exact operation to finish; unknown receipts still block it.
      const settled = flight.then(() => undefined, () => undefined);
      inFlightPromise = settled;
      try { return await flight; }
      finally { if (inFlightPromise === settled) inFlightPromise = null; }
    } finally {
      sharedCoordinator?.release(claimed);
      manualOperationPending = false;
      lease?.resume();
    }
  };

'''
edit(TS,'  const enqueue = (',manual_ts+'  const enqueue = (')
edit(TS,'    request: enqueue,','    runManualOperation,\n    request: enqueue,')
# Trusted dispatcher dependencies, NOT renderer arguments, carry the attempt ID.
for method in ['verifyNarrativeDependencyGraph','rebuildNarrativeDerivedState']:
 edit(IC,f'  {method}?(payload: unknown): Promise<string>;',f'  {method}?(payload: unknown, attemptId?: string): Promise<string>;')
edit(IC,'export interface DispatchDeps {','''export interface DispatchDeps {
  /** Main-owned lifecycle identity. Never read from CommandArgs. */
  maintenanceAttemptId?: string;''')
for command,require in [('verify_narrative_dependency_graph','requireVerifyNarrativeDependencyGraphPayload'),('rebuild_narrative_derived_state','requireRebuildNarrativeDerivedStatePayload')]:
 region(IC,'  '+command+': {','\n  },',lambda s: replace_once(replace_once(s,
 'run: async (b, a) =>','run: async (b, a, deps) =>'),
 f')({require}(a)),',f')({require}(a), requireMainMaintenanceAttempt(deps)),'))
edit(IC,'export interface DispatchDeps {','''function requireMainMaintenanceAttempt(deps: DispatchDeps): string {
  const id = deps.maintenanceAttemptId;
  if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
    throw new Error("NEX_MAINTENANCE_ATTEMPT_REQUIRED: manual maintenance must be owned by main");
  }
  return id;
}

export interface DispatchDeps {''')
# Wrap the existing dispatch; keep all policy/egress/response checks in place.
edit(IP,'      const dispatch = () =>','      const dispatch = (maintenanceAttemptId?: string) =>')
# This occurrence is in the dispatch closure rather than a global initializer.
region(IP,'      const dispatch = (maintenanceAttemptId','      let envelope',lambda s: replace_once(s,
 '          backend,','          backend,\n          maintenanceAttemptId,'))
# Support precise current control flow without modifying license semantics.
p=R/IP;s=p.read_text();marker='      let envelope';i=s.index(marker,s.index('      const dispatch = (maintenanceAttemptId'))
s=s[:i]+r'''      const dispatchOwned = async () => {
        if (cmd !== "verify_narrative_dependency_graph" && cmd !== "rebuild_narrative_derived_state") return dispatch();
        if (!narrativeMaintenance?.runManualOperation) throw new Error("NEX_MAINTENANCE_ATTEMPT_REQUIRED: maintenance owner is unavailable");
        const payload = dispatchArgs.payload;
        const projectId = payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).projectId : undefined;
        if (typeof projectId !== "string" || !projectId.trim()) throw new Error("projectId is required");
        return narrativeMaintenance.runManualOperation(projectId, async (attemptId) => {
          const envelope = await dispatch(attemptId);
          if (!envelope.ok) throw new Error(envelope.error);
          return envelope;
        });
      };
'''+s[i:]
# Calls after the closure only, exact expected sites.
a=s.index(marker,s.index('      const dispatchOwned'))
pre=s[:a];tail=s[a:];n=tail.count('await dispatch()');assert n==1,n;tail=tail.replace('await dispatch()','await dispatchOwned()')
tail=tail.replace('runManualOperation(dispatch)','runManualOperation(dispatchOwned)')
p.write_text(pre+tail);changed.add(IP)
# Keep generated declarations aligned until the NAPI build regenerates them.
p=R/'electron/native/grimodex-node/index.d.ts'
if p.exists():
 s=p.read_text()
 for method in ['verifyNarrativeDependencyGraph','rebuildNarrativeDerivedState']:
  s,n=re.subn(r'('+method+r'\(payload: [^\n)]*)(\): Promise<string>)',r'\1, attemptId?: string | undefined | null\2',s)
  assert n==1,(method,n)
 p.write_text(s);changed.add(str(p.relative_to(R)))
print('Lane B modified:',sorted(changed))
