import re,sys,collections,statistics
def rows(path):
    out=[]
    for line in open(path,errors='replace'):
        i=line.find('P7WORKER ')
        if i<0: continue
        line=line[i:]
        d={}
        d['tag']=re.search(r'tag=(\S*)',line).group(1)
        d['scenes']=int(re.search(r'scenes=(\d+)',line).group(1))
        d['seed']=re.search(r'seed=(\S+)',line).group(1)
        d['mode']=re.search(r'mode=(\S+)',line).group(1)
        d['ready']=re.search(r'ready=(\w+)',line).group(1)
        d['ready_ms']=float(re.search(r'ready_ms=([\d.]+)',line).group(1))
        d['query_ms']=float(re.search(r'query_ms=([\d.]+)',line).group(1))
        d['frame']=int(re.search(r'frame_bytes=(\d+)',line).group(1))
        d['exit']=re.search(r'exit=(\S+)',line).group(1)
        m=re.search(r'registration_hw=(\d+)',line); d['reg_hw']=int(m.group(1)) if m else None
        m=re.search(r'QUERY inner_ms=(\S+) status=(\S+) reason=(.*?) hw=(\d+)',line)
        if m:
            d['inner_ms']=float(m.group(1)); d['status']=m.group(2); d['reason']=m.group(3); d['q_hw']=int(m.group(4))
        m=re.search(r'FAIL (\w+) requested=(\d+) allocated=(\d+) available=(\d+)',line)
        d['fail']=m.groups() if m else None
        out.append(d)
    return out
if __name__=='__main__':
    for path in sys.argv[1:]:
        rs=rows(path)
        g=collections.OrderedDict()
        for r in rs: g.setdefault((r['tag'],r['scenes'],r['mode'],r['seed']),[]).append(r)
        for k,v in g.items():
            f=lambda x:[r[x] for r in v if r.get(x) is not None]
            def st(l):
                return f"{min(l):.1f}/{statistics.median(l):.1f}/{max(l):.1f}" if l else '-'
            print(k, 'n=',len(v),'status=',set((r.get('status'),(r.get('reason') or '')[:50]) for r in v),'reg_hw=',set(f('reg_hw')),'q_hw=',set(f('q_hw')),'frame=',set(f('frame')),'inner_ms(min/p50/max)=',st(f('inner_ms')),'query_ms=',st(f('query_ms')),'ready_ms=',st(f('ready_ms')),'exit=',set(f('exit')))
