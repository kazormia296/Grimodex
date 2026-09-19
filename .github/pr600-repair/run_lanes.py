from pathlib import Path
import runpy, shutil
root=Path(__file__).resolve().parent
runpy.run_path(str(root/'lane_a.py'),run_name='__main__')
source=(root/'lane_b.py').read_text()
a=source.index('# Wrap the existing dispatch;')
b=source.index('# Keep generated declarations aligned',a)
ns={'__name__':'__main__','__file__':str(root/'lane_b.py')}
exec(compile(source[:a],str(root/'lane_b.py'),'exec'),ns)
p=Path('electron/main/ipc.ts');s=p.read_text()
old='''        const dispatch = (): Promise<Envelope> =>
          dispatchInvoke(cmd, dispatchArgs, {
            backend,
'''
new='''        const dispatch = (maintenanceAttemptId?: string): Promise<Envelope> =>
          dispatchInvoke(cmd, dispatchArgs, {
            backend,
            maintenanceAttemptId,
'''
assert s.count(old)==1;s=s.replace(old,new)
old='''        let envelope: Envelope;
        try {
'''
new='''        const dispatchOwned = async (): Promise<Envelope> => {
          if (cmd !== "verify_narrative_dependency_graph" && cmd !== "rebuild_narrative_derived_state") return dispatch();
          if (!narrativeMaintenance?.runManualOperation) throw new Error("NEX_MAINTENANCE_ATTEMPT_REQUIRED: maintenance owner is unavailable");
          const payload = dispatchArgs.payload;
          const projectId = payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).projectId : undefined;
          if (typeof projectId !== "string" || !projectId.trim()) throw new Error("projectId is required");
          return narrativeMaintenance.runManualOperation(projectId, async (attemptId) => {
            const result = await dispatch(attemptId);
            if (!result.ok) throw new Error(result.error);
            return result;
          });
        };
        let envelope: Envelope;
        try {
'''
assert s.count(old)==1;s=s.replace(old,new)
old='''              ? await licenseValidation.runManualOperation(dispatch)
              : await dispatch();'''
new='''              ? await licenseValidation.runManualOperation(dispatchOwned)
              : await dispatchOwned();'''
assert s.count(old)==1;s=s.replace(old,new);p.write_text(s)
exec(compile(source[b:],str(root/'lane_b.py'),'exec'),ns)
runpy.run_path(str(root/'lane_c.py'),run_name='__main__')
for name in ['narrativeMaintenance.ownership.test.ts']:
 target=Path('electron/main')/name
 assert not target.exists()
 shutil.copyfile(root/name,target)
