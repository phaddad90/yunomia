// Yunomia — file-backed per-project ticket store. Self-contained, no external API.
//
// Layout:
//   ~/.yunomia/projects/<sanitised-cwd>/tickets.json
//   ~/.yunomia/projects/<sanitised-cwd>/comments.json
//   ~/.yunomia/projects/<sanitised-cwd>/audit.json
//   ~/.yunomia/projects/<sanitised-cwd>/counter.txt    (per-project monotonic ticket number)
//   ~/.yunomia/projects/<sanitised-cwd>/prefix.txt     (per-project 3-letter prefix, e.g. "ERP")
//
// Schema mirrors MC v0.3 so existing rendering patterns can be reused.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Ticket {
    pub id: String,
    pub human_id: String,
    pub r#type: String,            // bug | feature | doc | gate | migration | ops
    pub status: String,            // backlog | triage | assigned | in_progress | in_review | done | released
    pub title: String,
    pub body_md: String,
    pub assignee_agent: Option<String>,
    pub audience: String,          // app | admin
    pub references_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Comment {
    pub id: String,
    pub ticket_id: String,
    pub body_md: String,
    pub author_label: String,      // e.g. "🛠 TA" or "🎩 PETER"
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AuditEntry {
    pub id: String,
    pub ticket_id: Option<String>,
    pub action: String,            // ticket.created / status_changed / commented / assigned / patched
    pub actor: String,             // human or agent code
    pub details: serde_json::Value,
    pub created_at: String,
}

fn yunomia_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".yunomia")
}

fn sanitise(cwd: &str) -> String {
    cwd.trim_start_matches('/').replace('/', "-").replace(' ', "_")
}

fn project_dir(cwd: &str) -> PathBuf {
    yunomia_dir().join("projects").join(sanitise(cwd))
}

fn ensure_project_dir(cwd: &str) -> Result<PathBuf, String> {
    let dir = project_dir(cwd);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> Result<T, String> {
    if !path.exists() { return Ok(T::default()); }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() { return Ok(T::default()); }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_json<T: Serialize>(path: &PathBuf, val: &T) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(val).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn now_iso() -> String { chrono::Utc::now().to_rfc3339() }
fn new_uuid() -> String { uuid::Uuid::new_v4().to_string() }

fn project_prefix(cwd: &str, dir: &PathBuf) -> String {
    let path = dir.join("prefix.txt");
    if let Ok(p) = fs::read_to_string(&path) {
        let trimmed = p.trim();
        if !trimmed.is_empty() { return trimmed.to_string(); }
    }
    let base = cwd.trim_end_matches('/').rsplit('/').next().unwrap_or("TKT");
    let mut letters: String = base.chars().filter(|c| c.is_ascii_alphabetic()).take(3).collect::<String>().to_uppercase();
    while letters.len() < 3 { letters.push('X'); }
    if letters.trim().is_empty() { letters = "TKT".into(); }
    let _ = fs::write(&path, &letters);
    letters
}

fn next_human_id(cwd: &str, dir: &PathBuf) -> String {
    let counter_path = dir.join("counter.txt");
    let next = fs::read_to_string(&counter_path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0) + 1;
    let _ = fs::write(&counter_path, next.to_string());
    let prefix = project_prefix(cwd, dir);
    format!("{}-{:03}", prefix, next)
}

#[derive(Deserialize)]
pub struct ListArgs {
    pub cwd: String,
}

#[tauri::command]
pub fn tickets_list(args: ListArgs) -> Result<Vec<Ticket>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("tickets.json");
    let tickets: Vec<Ticket> = read_json(&path)?;
    Ok(tickets)
}

#[derive(Deserialize)]
pub struct CreateArgs {
    pub cwd: String,
    pub title: String,
    pub body_md: String,
    pub r#type: String,
    pub status: Option<String>,
    pub audience: Option<String>,
    pub assignee_agent: Option<String>,
}

#[tauri::command]
pub fn tickets_create(args: CreateArgs) -> Result<Ticket, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("tickets.json");
    let mut tickets: Vec<Ticket> = read_json(&path)?;
    let now = now_iso();
    let ticket = Ticket {
        id: new_uuid(),
        human_id: next_human_id(&args.cwd, &dir),
        r#type: args.r#type,
        status: args.status.unwrap_or_else(|| "triage".into()),
        title: args.title,
        body_md: args.body_md,
        assignee_agent: args.assignee_agent,
        audience: args.audience.unwrap_or_else(|| "admin".into()),
        references_json: None,
        created_at: now.clone(),
        updated_at: now,
    };
    tickets.push(ticket.clone());
    write_json(&path, &tickets)?;
    write_audit(&dir, "ticket.created", &ticket.id, "user", serde_json::json!({ "human_id": ticket.human_id, "title": ticket.title }))?;
    Ok(ticket)
}

#[derive(Deserialize)]
pub struct PatchArgs {
    pub cwd: String,
    pub id: String,
    pub fields: serde_json::Map<String, serde_json::Value>,
}

#[tauri::command]
pub fn tickets_patch(args: PatchArgs) -> Result<Ticket, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("tickets.json");
    let mut tickets: Vec<Ticket> = read_json(&path)?;
    let idx = tickets.iter().position(|t| t.id == args.id).ok_or_else(|| "ticket not found".to_string())?;
    let mut t = tickets[idx].clone();
    let mut changed = serde_json::Map::new();
    for (k, v) in args.fields.iter() {
        match k.as_str() {
            "title"          => if let Some(s) = v.as_str() { t.title = s.into(); changed.insert(k.clone(), v.clone()); },
            "body_md" | "bodyMd" => if let Some(s) = v.as_str() { t.body_md = s.into(); changed.insert("body_md".into(), v.clone()); },
            "type"           => if let Some(s) = v.as_str() { t.r#type = s.into(); changed.insert(k.clone(), v.clone()); },
            "audience"       => if let Some(s) = v.as_str() { t.audience = s.into(); changed.insert(k.clone(), v.clone()); },
            "status"         => if let Some(s) = v.as_str() { t.status = s.into(); changed.insert(k.clone(), v.clone()); },
            "assignee_agent" | "assigneeAgent" => {
                if v.is_null() { t.assignee_agent = None; }
                else if let Some(s) = v.as_str() { t.assignee_agent = Some(s.into()); }
                changed.insert("assignee_agent".into(), v.clone());
            }
            _ => {}
        }
    }
    t.updated_at = now_iso();
    tickets[idx] = t.clone();
    write_json(&path, &tickets)?;
    write_audit(&dir, "ticket.patched", &t.id, "user", serde_json::Value::Object(changed))?;
    Ok(t)
}

#[derive(Deserialize)]
pub struct TransitionArgs {
    pub cwd: String,
    pub id: String,
    pub action: String,            // start | handoff | done | reopen
}

#[tauri::command]
pub fn tickets_transition(args: TransitionArgs) -> Result<Ticket, String> {
    let next = match args.action.as_str() {
        "start"    => "in_progress",
        "handoff"  => "in_review",
        "done"     => "done",
        "reopen"   => "assigned",
        _          => return Err(format!("unknown action {}", args.action)),
    };
    let mut fields = serde_json::Map::new();
    fields.insert("status".into(), serde_json::Value::String(next.into()));
    tickets_patch(PatchArgs { cwd: args.cwd, id: args.id, fields })
}

#[derive(Deserialize)]
pub struct CommentsListArgs {
    pub cwd: String,
    pub ticket_id: Option<String>,
}

#[tauri::command]
pub fn comments_list(args: CommentsListArgs) -> Result<Vec<Comment>, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("comments.json");
    let comments: Vec<Comment> = read_json(&path)?;
    Ok(match args.ticket_id {
        Some(id) => comments.into_iter().filter(|c| c.ticket_id == id).collect(),
        None     => comments,
    })
}

#[derive(Deserialize)]
pub struct CommentCreateArgs {
    pub cwd: String,
    pub ticket_id: String,
    pub body_md: String,
    pub author_label: String,
}

#[tauri::command]
pub fn comments_create(args: CommentCreateArgs) -> Result<Comment, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("comments.json");
    let mut comments: Vec<Comment> = read_json(&path)?;
    let comment = Comment {
        id: new_uuid(),
        ticket_id: args.ticket_id.clone(),
        body_md: args.body_md,
        author_label: args.author_label,
        created_at: now_iso(),
    };
    comments.push(comment.clone());
    write_json(&path, &comments)?;
    write_audit(&dir, "ticket.commented", &args.ticket_id, &comment.author_label, serde_json::json!({ "comment_id": comment.id }))?;
    Ok(comment)
}

// Per-project lifecycle state: onboarding (no tickets yet, lead agent
// interviewing the user) vs active (brief approved, tickets in flight).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ProjectState {
    pub phase: String,                  // "onboarding" | "active"
    pub project_name: String,
    pub created_at: String,
    pub brief_finalised_at: Option<String>,
    pub lead_spawned_at: Option<String>,
}

impl Default for ProjectState {
    fn default() -> Self {
        Self {
            phase: "onboarding".into(),
            project_name: String::new(),
            created_at: now_iso(),
            brief_finalised_at: None,
            lead_spawned_at: None,
        }
    }
}

#[derive(Deserialize)]
pub struct StateGetArgs {
    pub cwd: String,
}

#[tauri::command]
pub fn project_state_get(args: StateGetArgs) -> Result<ProjectState, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("state.json");
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if !raw.trim().is_empty() {
            return serde_json::from_str(&raw).map_err(|e| e.to_string());
        }
    }
    Ok(ProjectState::default())
}

#[derive(Deserialize)]
pub struct StateSetArgs {
    pub cwd: String,
    pub patch: serde_json::Map<String, serde_json::Value>,
}

#[tauri::command]
pub fn project_state_set(args: StateSetArgs) -> Result<ProjectState, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("state.json");
    let mut state: ProjectState = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() { ProjectState::default() } else { serde_json::from_str(&raw).map_err(|e| e.to_string())? }
    } else {
        ProjectState::default()
    };
    for (k, v) in args.patch.iter() {
        match k.as_str() {
            "phase"               => if let Some(s) = v.as_str() { state.phase = s.into(); },
            "project_name"        => if let Some(s) = v.as_str() { state.project_name = s.into(); },
            "brief_finalised_at"  => state.brief_finalised_at = v.as_str().map(|s| s.to_string()),
            "lead_spawned_at"     => state.lead_spawned_at = v.as_str().map(|s| s.to_string()),
            _ => {}
        }
    }
    write_json(&path, &state)?;
    Ok(state)
}

// Brief is the canonical scope document. The Lead agent writes here as the
// onboarding conversation evolves.
#[derive(Deserialize)]
pub struct BriefArgs {
    pub cwd: String,
}

#[tauri::command]
pub fn brief_get(args: BriefArgs) -> Result<String, String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("brief.md");
    if !path.exists() { return Ok(String::new()); }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct BriefWriteArgs {
    pub cwd: String,
    pub markdown: String,
}

#[tauri::command]
pub fn brief_write(args: BriefWriteArgs) -> Result<(), String> {
    let dir = ensure_project_dir(&args.cwd)?;
    let path = dir.join("brief.md");
    fs::write(&path, args.markdown).map_err(|e| e.to_string())
}

fn write_audit(dir: &PathBuf, action: &str, ticket_id: &str, actor: &str, details: serde_json::Value) -> Result<(), String> {
    let path = dir.join("audit.json");
    let mut audit: Vec<AuditEntry> = read_json(&path)?;
    audit.push(AuditEntry {
        id: new_uuid(),
        ticket_id: Some(ticket_id.to_string()),
        action: action.into(),
        actor: actor.into(),
        details,
        created_at: now_iso(),
    });
    write_json(&path, &audit)
}
