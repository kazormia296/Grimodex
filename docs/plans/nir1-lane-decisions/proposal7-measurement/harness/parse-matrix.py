import re,sys
for path in sys.argv[1:]:
    print('##',path)
    for line in open(path,errors='replace'):
        m=re.search(r'P7ROW scenes=(\d+) mode=(\w+) seed=(\S+) revisions=(\d+).*? records=(\d+) replay_steps=(\d+) entities=(\d+) edges=(\d+).*?production=(\S+) charged_rows=\S+ usage\(rows,bytes,pages,retained,peak\)=(\S+?)\) ',line)
        if not m:
            m2=re.search(r'P7ROW scenes=(\d+) mode=(\w+) seed=(\S+) revisions=(\d+).*? records=(\d+) replay_steps=(\d+) entities=(\d+) edges=(\d+).*?production=(\S+)',line)
            if m2:
                s,mode,seed,rev,rec,steps,ent,edge,prod=m2.groups()
                print(f'S={s} {seed} records={rec} steps={steps} ent={ent} edge={edge} prod={prod}')
            continue
        s,mode,seed,rev,rec,steps,ent,edge,prod,usage=m.groups()
        u=usage.replace('Some((','').split(',')
        print(f'S={s} {seed} records={rec} steps={steps} ent={ent} edge={edge} prod={prod} pages={u[2]} retained={u[3]} peak={u[4].rstrip(")")}')
