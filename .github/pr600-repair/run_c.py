from pathlib import Path
root=Path(__file__).resolve().parent
source=(root/'lane_c.py').read_text()
a=source.index('for begin,end in ');b=source.index("helper='''",a)
replacement='''for begin,end,tuple_value in [
 ('    let (run_id, semantic_epoch_id, already_running) = run_maintenance_graph_phase(', '    if already_running {', True),
 ('    let created = run_maintenance_graph_phase(', '    let run_id = created.run_id;', False),
]:
 a=s.index(begin);b=s.index(end,a);part=s[a:b]
 part=part.replace('run_maintenance_graph_phase(', 'run_maintenance_creation_phase(',1)
 indent='            ' if tuple_value else '        '
 old=indent+'with_immediate_transaction(conn, |conn| {'
 assert part.count(old)==1,part
 part=part.replace(old,indent+'let created = with_immediate_transaction(conn, |conn| {',1)
 old=indent+'})'
 i=part.rfind(old)
 assert i>=0,part
 id_expr='(!created.2).then(|| created.0.clone())' if tuple_value else '(!created.reused).then(|| created.run_id.clone())'
 replacement=old+'?;\\n'+indent+'let run = '+id_expr+';\\n'+indent+'Ok((created, run))'
 part=part[:i]+replacement+part[i+len(old):]
 s=s[:a]+part+s[b:]
'''
source=source[:a]+replacement+source[b:]
exec(compile(source,str(root/'lane_c.py'),'exec'),{'__name__':'__main__','__file__':str(root/'lane_c.py')})
