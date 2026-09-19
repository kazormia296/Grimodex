from pathlib import Path
import sys
root=Path(__file__).resolve().parent
source=(root/'run_lanes.py').read_text()
old="runpy.run_path(str(root/'lane_c.py'),run_name='__main__')"
assert source.count(old)==1
source=source.replace(old,"runpy.run_path(str(root/'run_c.py'),run_name='__main__')")
try:
 exec(compile(source,str(root/'run_lanes.py'),'exec'),{'__name__':'__main__','__file__':str(root/'run_lanes.py')})
except Exception as error:
 print('::error::Repair application failed: '+str(error).replace('\n','%0A'),file=sys.stderr)
 raise
