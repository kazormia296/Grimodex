//! Aggregate foreshadow operations used by narrative commits.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::codex_operations::PatchFieldString;

pub(crate) const OP_KIND_FORESHADOW_AGGREGATE_CREATE: &str = "foreshadow.aggregate.create";
pub(crate) const OP_KIND_FORESHADOW_AGGREGATE_PATCH: &str = "foreshadow.aggregate.patch";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Setup { pub setup_id: String, pub scene_id: String, pub from_pos: i64, pub to_pos: i64, pub role: String, pub kind: String, #[serde(default)] pub ai_strength: Option<String>, #[serde(default)] pub rationale: Option<String>, #[serde(default)] pub semantic_key: Option<String> }
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Payoff { pub payoff_id: String, pub scene_id: String, pub from_pos: i64, pub to_pos: i64, pub role: String, pub confirmed: bool, pub primary: bool, #[serde(default)] pub rationale: Option<String>, #[serde(default)] pub semantic_key: Option<String> }
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Edge { pub setup_id: String, pub payoff_id: String, pub bridge_kind: String, #[serde(default)] pub explanation: Option<String> }
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatePayload { pub foreshadow_id: String, pub hypothesis_id: String, pub title: String, #[serde(default)] pub intent: Option<String>, #[serde(default)] pub mechanism: Option<String>, pub secret: bool, #[serde(default)] pub setups: Vec<Setup>, #[serde(default)] pub payoffs: Vec<Payoff>, #[serde(default)] pub support_edges: Vec<Edge>, #[serde(default)] pub codex_entry_ids: Vec<String> }
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PatchPayload { pub foreshadow_id: String, pub hypothesis_id: String, pub base_version: i64, #[serde(default)] pub intent: Option<PatchFieldString>, #[serde(default)] pub mechanism: Option<PatchFieldString>, #[serde(default)] pub add_setups: Vec<Setup>, #[serde(default)] pub add_payoffs: Vec<Payoff>, #[serde(default)] pub add_support_edges: Vec<Edge>, #[serde(default)] pub add_codex_entry_ids: Vec<String> }
#[derive(Clone, Debug)]
pub(crate) struct Result { pub entity_id: String, pub version: i64, pub after_snapshot: Value, pub before_snapshot: Option<Value>, pub op_kind: &'static str }

pub(crate) fn parse_create(v: &Value) -> anyhow::Result<CreatePayload> { serde_json::from_value(v.clone()).map_err(|e| anyhow::anyhow!("invalid foreshadow.aggregate.create payload: {e}")) }
pub(crate) fn parse_patch(v: &Value) -> anyhow::Result<PatchPayload> { serde_json::from_value(v.clone()).map_err(|e| anyhow::anyhow!("invalid foreshadow.aggregate.patch payload: {e}")) }
pub(crate) fn ensure_id_available(c: &Connection, project: &str, id: &str) -> anyhow::Result<()> { let n:i64=c.query_row("SELECT COUNT(*) FROM foreshadows WHERE id=?1 AND project_id=?2",params![id,project],|r|r.get(0))?; anyhow::ensure!(n==0,"foreshadow '{id}' already exists"); Ok(()) }
pub(crate) fn ensure_version(c: &Connection, project:&str,id:&str,version:i64)->anyhow::Result<()> { let found:Option<i64>=c.query_row("SELECT version FROM foreshadows WHERE id=?1 AND project_id=?2",params![id,project],|r|r.get(0)).optional()?; match found {Some(v) if v==version=>Ok(()),Some(v)=>anyhow::bail!("NEX_FORESHADOW_VERSION_MISMATCH: foreshadow '{id}' expected version {version}, found {v}"),None=>anyhow::bail!("foreshadow '{id}' not found")} }
fn scene(c:&Connection,p:&str,id:&str)->anyhow::Result<()> { let n:i64=c.query_row("SELECT COUNT(*) FROM tree_nodes WHERE id=?1 AND project_id=?2 AND node_type='scene'",params![id,p],|r|r.get(0))?; anyhow::ensure!(n==1,"scene '{id}' not found in project '{p}'");Ok(()) }
fn key(root:&str, scene:&str, from:i64,to:i64,given:&Option<String>)->String { given.clone().unwrap_or_else(||format!("{root}|{scene}|{from}|{to}")) }
fn validate_items(c:&Connection,p:&str,setups:&[Setup],payoffs:&[Payoff],edges:&[Edge])->anyhow::Result<()> {
 anyhow::ensure!(!setups.is_empty()||!payoffs.is_empty(),"foreshadow aggregate requires at least one setup or payoff");
 for s in setups { anyhow::ensure!(s.from_pos>=0&&s.to_pos>=s.from_pos,"invalid setup range"); scene(c,p,&s.scene_id)?; }
 for x in payoffs { anyhow::ensure!(x.from_pos>=0&&x.to_pos>=x.from_pos,"invalid payoff range"); scene(c,p,&x.scene_id)?; }
 for s in setups { for x in payoffs { if s.scene_id==x.scene_id { anyhow::ensure!(s.from_pos<x.from_pos,"setup must precede payoff in the same scene"); } } }
 for e in edges { anyhow::ensure!(setups.iter().any(|s|s.setup_id==e.setup_id)||exists_setup(c,&e.setup_id)?, "support edge setup '{}' not found",e.setup_id); anyhow::ensure!(payoffs.iter().any(|x|x.payoff_id==e.payoff_id)||exists_payoff(c,&e.payoff_id)?, "support edge payoff '{}' not found",e.payoff_id); }
 Ok(())
}
fn exists_setup(c:&Connection,id:&str)->anyhow::Result<bool>{c.query_row("SELECT EXISTS(SELECT 1 FROM foreshadow_setups WHERE id=?1)",params![id],|r|r.get(0)).map_err(Into::into)}
fn exists_payoff(c:&Connection,id:&str)->anyhow::Result<bool>{c.query_row("SELECT EXISTS(SELECT 1 FROM foreshadow_payoffs WHERE id=?1)",params![id],|r|r.get(0)).map_err(Into::into)}
fn insert_children(c:&Connection,root:&str,setups:&[Setup],payoffs:&[Payoff],edges:&[Edge],codex:&[String])->anyhow::Result<()> { let now=Utc::now().timestamp_millis();
 for s in setups { c.execute("INSERT INTO foreshadow_setups (id,foreshadow_id,scene_id,from_pos,to_pos,kind,ai_strength,ai_rationale,role,semantic_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",params![s.setup_id,root,s.scene_id,s.from_pos,s.to_pos,s.kind,s.ai_strength,s.rationale,s.role,key(root,&s.scene_id,s.from_pos,s.to_pos,&s.semantic_key),now])?; }
 for x in payoffs { c.execute("INSERT INTO foreshadow_payoffs (id,foreshadow_id,scene_id,from_pos,to_pos,role,confirmed,is_primary,attribution,ai_rationale,semantic_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'ai',?9,?10,?11,?11)",params![x.payoff_id,root,x.scene_id,x.from_pos,x.to_pos,x.role,x.confirmed as i64,x.primary as i64,x.rationale,key(root,&x.scene_id,x.from_pos,x.to_pos,&x.semantic_key),now])?; }
 for e in edges { c.execute("INSERT INTO foreshadow_setup_payoff_links (foreshadow_id,setup_id,payoff_id,bridge_kind,explanation,created_at) VALUES (?1,?2,?3,?4,?5,?6)",params![root,e.setup_id,e.payoff_id,e.bridge_kind,e.explanation,now])?; }
 for id in codex { c.execute("INSERT OR IGNORE INTO foreshadow_codex_links (foreshadow_id,codex_entry_id) VALUES (?1,?2)",params![root,id])?; } Ok(()) }
fn mirror(c:&Connection,root:&str)->anyhow::Result<()> { let primary:Option<(String,i64,i64,i64)>=c.query_row("SELECT scene_id,from_pos,to_pos,confirmed FROM foreshadow_payoffs WHERE foreshadow_id=?1 AND is_primary=1 ORDER BY id LIMIT 1",params![root],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?; if let Some((s,f,t,ok))=primary { c.execute("UPDATE foreshadows SET payoff_scene_id=?1,payoff_from_pos=?2,payoff_to_pos=?3,payoff_confirmed=?4 WHERE id=?5",params![s,f,t,ok,root])?; } Ok(()) }
pub(crate) fn snapshot(c:&Connection,id:&str)->anyhow::Result<Value>{ let root:String=c.query_row("SELECT json_object('id',id,'projectId',project_id,'title',title,'intent',intent,'mechanism',mechanism,'secret',secret,'version',version) FROM foreshadows WHERE id=?1",params![id],|r|r.get(0))?; Ok(serde_json::from_str(&root)?) }
pub(crate) fn apply_create(c:&Connection,p:&str,x:&CreatePayload,_now:&str)->anyhow::Result<Result>{ensure_id_available(c,p,&x.foreshadow_id)?;validate_items(c,p,&x.setups,&x.payoffs,&x.support_edges)?;let stamp=Utc::now().timestamp_millis();c.execute("INSERT INTO foreshadows (id,project_id,title,intent,mechanism,secret,notes,load_bearing,abandoned,version,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,NULL,NULL,0,0,?7,?7)",params![x.foreshadow_id,p,x.title,x.intent,x.mechanism,x.secret as i64,stamp])?;insert_children(c,&x.foreshadow_id,&x.setups,&x.payoffs,&x.support_edges,&x.codex_entry_ids)?;mirror(c,&x.foreshadow_id)?;Ok(Result{entity_id:x.foreshadow_id.clone(),version:0,after_snapshot:snapshot(c,&x.foreshadow_id)?,before_snapshot:None,op_kind:"create"})}
pub(crate) fn apply_patch(c:&Connection,p:&str,x:&PatchPayload,now:&str)->anyhow::Result<Result>{ensure_version(c,p,&x.foreshadow_id,x.base_version)?;validate_items(c,p,&x.add_setups,&x.add_payoffs,&x.add_support_edges)?;let before=snapshot(c,&x.foreshadow_id)?;insert_children(c,&x.foreshadow_id,&x.add_setups,&x.add_payoffs,&x.add_support_edges,&x.add_codex_entry_ids)?; let (intent,mechanism):(Option<String>,Option<String>)=c.query_row("SELECT intent,mechanism FROM foreshadows WHERE id=?1",params![x.foreshadow_id],|r|Ok((r.get(0)?,r.get(1)?)) )?; let update=|f:&Option<PatchFieldString>,old:Option<String>|->anyhow::Result<Option<String>>{match f {None=>Ok(old),Some(v) if v.kind=="leave"=>Ok(old),Some(v) if v.kind=="fill-if-empty"||v.kind=="set-if-empty"=>{if old.as_deref().map(str::trim).unwrap_or("").is_empty(){Ok(v.value.clone())}else{Ok(old)}},Some(v)=>anyhow::bail!("unsupported foreshadow patch kind '{}'",v.kind)}}; let ni=update(&x.intent,intent)?;let nm=update(&x.mechanism,mechanism)?;let next=x.base_version.checked_add(1).ok_or_else(||anyhow::anyhow!("foreshadow version overflow"))?;let changed=c.execute("UPDATE foreshadows SET intent=?1,mechanism=?2,version=?3,updated_at=?4 WHERE id=?5 AND project_id=?6 AND version=?7",params![ni,nm,next,now,x.foreshadow_id,p,x.base_version])?;anyhow::ensure!(changed==1,"NEX_FORESHADOW_VERSION_MISMATCH: patch conflict");mirror(c,&x.foreshadow_id)?;Ok(Result{entity_id:x.foreshadow_id.clone(),version:next,after_snapshot:snapshot(c,&x.foreshadow_id)?,before_snapshot:Some(before),op_kind:"patch"})}
