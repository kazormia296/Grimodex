import json,os,math
res=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'result.json')))
def mean(x): return sum(x)/len(x)
sets={'all13':res,'base8':[r for r in res if r['variant'] in ('G-01/v1','G-02/base','G-03/base','G-04/base','G-05/base','G-06/base','G-07/base','G-08/base-usable')]}
for n,rs in sets.items():
    print(n,len(rs))
    for a in ('R','R+IR','R+IR+Graph'):
        print(' ',a,'recall',round(mean([r['arms'][a]['meanRecall'] for r in rs]),6),'ndcg',round(mean([r['arms'][a]['meanNdcg'] for r in rs]),6),
              'expRecall',round(mean([r['arms'][a]['expectedRecall'] for r in rs]),6),'expNdcg',round(mean([r['arms'][a]['expectedNdcg'] for r in rs]),6))
    for lo,hi in (('R','R+IR'),('R+IR','R+IR+Graph'),('R','R+IR+Graph')):
        reg=[r['variant'] for r in rs if r['arms'][hi]['meanNdcg']<r['arms'][lo]['meanNdcg']-1e-12 or r['arms'][hi]['meanRecall']<r['arms'][lo]['meanRecall']-1e-12]
        print('  regress',lo,'->',hi,reg)
# linear-gain sensitivity
import glob
fixm={}
for r in res:
    pass
