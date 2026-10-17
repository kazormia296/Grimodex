import re,sys,glob
for tag in ['q4_5MiB','q8MiB','q16MiB','q32MiB']:
    print('==',tag)
    for line in open(f'raw/product-{tag}.txt',errors='replace'):
        i=line.find('P7PROD ')
        if i<0: continue
        line=line[i:]
        case=re.search(r'case=(\S+)',line).group(1)
        a2=re.search(r'a2=(\S+)',line).group(1)
        ped=re.search(r'payload_envelope_decision=\(([^)]*)\)',line).group(1)
        ready=re.search(r'ready=(\w+)',line).group(1)
        fb=re.search(r'frame_bytes=(\d+)',line).group(1)
        ex=re.search(r'exit=(\S+)',line).group(1)
        rhw=re.search(r'registration_hw=(\d+)',line)
        qhw=re.search(r'QUERY inner_ms=(\S+) status=(\S+) reason=(\S+) hw=(\d+)',line)
        fail=re.search(r'FAIL (\w+) requested=(\d+) allocated=(\d+) available=(\d+)',line)
        nomem=re.search(r'(NIR1_C_QUERY_REG_NOMEM\S*|memory allocation of \d+ bytes failed)',line)
        print(f"{case:12} a2={a2:12} ped=({ped}) ready={ready} frame={fb:8} exit={ex} reg_hw={rhw.group(1) if rhw else '-'} q_hw={qhw.group(4) if qhw else '-'} q={qhw.group(2) if qhw else '-'}/{qhw.group(3)[:40] if qhw else '-'} inner_ms={qhw.group(1) if qhw else '-'} fail={fail.groups() if fail else '-'} {nomem.group(1) if nomem else ''}")
