from pathlib import Path
import runpy
root=Path(__file__).resolve().parent
runpy.run_path(str(root/'lane_a.py'),run_name='__main__')
source=(root/'lane_b.py').read_text()
old="edit(IP,'      const dispatch = () =>','      const dispatch = (maintenanceAttemptId?: string) =>')"
new="edit(IP,'        const dispatch = (): Promise<Envelope> =>','        const dispatch = (maintenanceAttemptId?: string): Promise<Envelope> =>')"
assert source.count(old)==1
source=source.replace(old,new)
exec(compile(source,str(root/'lane_b.py'),'exec'),{'__name__':'__main__','__file__':str(root/'lane_b.py')})
runpy.run_path(str(root/'lane_c.py'),run_name='__main__')
