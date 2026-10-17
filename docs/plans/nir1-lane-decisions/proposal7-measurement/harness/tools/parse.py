import re, sys, json, collections
def parse_rows(path):
    rows=[]
    for line in open(path, errors='replace'):
        i=line.find('P7ROW ')
        if i<0: continue
        line=line[i:]
        d={}
        head, _, tail = line.partition(' | production=')
        for m in re.finditer(r'(\w+)=(\{[^}]*\}|\S+)', head):
            d[m.group(1)]=m.group(2)
        prod, _, rest = tail.partition(' | uncapped_steps=')
        d['production']=prod.split(' ')[0]
        for m in re.finditer(r'(\w+)=(\S+)', prod):
            d[m.group(1)]=m.group(2)
        unc, _, tim = rest.partition(' | query_ms[')
        d['uncapped']=unc.strip()
        q, _, r = tim.partition('] reg_ms[')
        d['query_ms']=q
        d['reg_ms']=r.rstrip(']\n')
        m=re.search(r'usage\(rows,bytes,pages,retained,peak\)=Some\(\((\d+), (\d+), (\d+), (\d+), (\d+)\)\)',line)
        if m:
            d['u_rows'],d['u_bytes'],d['u_pages'],d['u_retained'],d['u_peak']=map(int,m.groups())
        m=re.search(r'charged_steps=Some\((\d+)\)',line)
        d['c_steps']=int(m.group(1)) if m else None
        m=re.search(r'query_ms\[n=(\d+) min=([\d.]+) p50=([\d.]+) max=([\d.]+)',line) if False else None
        for k in ['scenes','revisions','eligible','candidate_rows','a2_rows','shared_rows','a3_rows','records','replay_steps','entities','edges','a2_bytes','a3_bytes','shared_bytes','max_revision_bytes','max_payload_bytes']:
            d[k]=int(d[k])
        rows.append(d)
    return rows
def reason_short(prod):
    m=re.match(r'(\w+)/(.*)', prod)
    st, rs = m.group(1), m.group(2)
    if st=='available': return 'available'
    rs=rs.strip('Some()"')
    rs=rs.replace('query-worker-','').replace('-pre-cleanup-work-failed','')
    return 'unavail:'+rs
if __name__=='__main__':
    rows=parse_rows(sys.argv[1])
    print(len(rows))
    for r in rows[:3]: print(r)
