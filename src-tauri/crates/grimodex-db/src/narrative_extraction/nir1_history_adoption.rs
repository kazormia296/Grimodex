//! The adoption rule of the history run (DI1B-2; K4/3 sections 6, 8 and 12,
//! K1b rule 5): from the candidates the run qualified and the bodies it read,
//! the turns the final request carries, oldest first, and a closed reason for
//! every turn it does not carry.
//!
//! Qualification is not decided here. HC-1's run decides what may be sent at
//! all; this function only chooses, among the qualified, what the request
//! carries. It adds no authority: a turn that the run did not qualify is not in
//! its input, and nothing here makes an excluded candidate adoptable. It reads
//! nothing and writes nothing; the bodies are the ones the run read and
//! authenticated (`SessionHistoryOutcome::materials`), so nothing is read twice
//! and no other read path exists. The only thing it asks of its caller is the
//! cost of reading a turn's parent attempt back at create, through a closure,
//! and only for the turns it is about to adopt.
//!
//! The unit is the turn of one attempt: the past Human of the attempt and, when
//! the attempt succeeded and its output qualified, the generated output. The
//! two are adopted together or dropped together; a turn without an adopted
//! output is its Human alone. A message is never shortened.
//!
//! Three decisions K4/3 left to DI-1b (recorded in DR-DI1B-5):
//!
//! * (a) The Human of a turn that has no output is adopted, in its place in
//!   the order. The chat the user sees keeps that message, and the existing
//!   chat path sends consecutive user messages as they are.
//! * (b) A Human without an output whose text is exactly the text of the user
//!   message that follows it in the request (the next adopted Human, or the
//!   current Human) is not adopted: the resend repeats it. The comparison is
//!   byte equality of the body; there is no normalization and no partial or
//!   semantic match. The Human of a turn with an output is never dropped by
//!   this rule.
//! * (c) A reply written against a Scene body that has since changed (the
//!   attempt's recorded `bodyDigest` is not the body's digest now) is adopted
//!   like any other, in order. The current body goes in as Raw next to it. The
//!   turn is marked [`AdoptedTurn::scene_body_changed`] for the caller to count;
//!   nothing is added to the payload. When the budget does not hold every
//!   turn the window is the newest turns, not a selection that prefers matching
//!   replies, so the conversation has no hole the user cannot see.
//!
//! The window is the newest turns that all fit, in order: the first turn (from
//! the newest) that does not fit one of the limits ends the window, and every
//! older turn is left out with [`NotAdoptedReason::BeyondWindowEnd`]. A turn
//! that cannot be adopted for its own message (a body that is gone, blank,
//! over the per-message limit, or not the message the candidate named) ends the
//! window the same way: it is one more "this turn does not go in", and a turn
//! that is missing from the middle of the conversation would leave a later
//! instruction ("shorten that") pointing at something that is not there. (A
//! turn whose candidate the run excluded is different: that is a decision of
//! the run's authorization, not of this function, and it is already absent.)
//! The one place the position of such a turn is unknown (no material was
//! handed on for its attempt, which the run never does for a qualified
//! candidate) is treated as the newest, so nothing is adopted: the narrower
//! side.

use std::collections::BTreeMap;

use anyhow::Result;
use grimodex_core::narrative_nir1::estimate_nir1_context_tokens;

use super::nir1_history_budget::{
    ParentReadCost, CREATE_PARENT_READ_BYTES, CREATE_PARENT_READ_ROWS, HISTORY_MAX_MESSAGES,
    HISTORY_MAX_MESSAGE_BYTES, HISTORY_MAX_TOKENS, HISTORY_MAX_TURNS,
};
use crate::nir1_generation::{InputReference, InputRole, InputTarget, InputUse, MessageOrigin};
use crate::nir1_generation_history::{
    AttemptId, CandidateDisposition, HistoryMessageMaterial, SessionCandidateKind,
    SessionCandidateResult, SessionHistoryOutcome,
};

/// What the request can hold of history. Every value is a limit on what is
/// adopted; none of them lets anything more be adopted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AdoptionLimits {
    /// Turns. At most [`HISTORY_MAX_TURNS`] in production.
    pub max_turns: usize,
    /// Messages. At most [`HISTORY_MAX_MESSAGES`] in production.
    pub max_messages: usize,
    /// Bytes of one message body; a longer message is not shortened and its
    /// turn is not adopted.
    pub max_message_bytes: usize,
    /// Tokens the history may take: what is left of the request's budget after
    /// the required Raw and the accepted IR, at most [`HISTORY_MAX_TOKENS`] in
    /// production. The caller computes the remainder.
    pub token_budget: usize,
    /// The tokens a chat message costs besides its text (its envelope).
    pub message_envelope_tokens: usize,
    /// The create's parent read budget (rows and bytes of stored reference
    /// JSON); the parents of the adopted outputs together must fit it.
    pub parent_read_rows: usize,
    pub parent_read_bytes: usize,
}

impl AdoptionLimits {
    /// The production limits for a request whose remaining token budget is
    /// `remaining_tokens` and whose chat messages cost `message_envelope_tokens`
    /// each besides their text.
    pub(crate) fn production(remaining_tokens: usize, message_envelope_tokens: usize) -> Self {
        Self {
            max_turns: HISTORY_MAX_TURNS,
            max_messages: HISTORY_MAX_MESSAGES,
            max_message_bytes: HISTORY_MAX_MESSAGE_BYTES,
            token_budget: remaining_tokens.min(HISTORY_MAX_TOKENS),
            message_envelope_tokens,
            parent_read_rows: CREATE_PARENT_READ_ROWS,
            parent_read_bytes: CREATE_PARENT_READ_BYTES,
        }
    }
}

/// Why a turn is not in the request. A closed set: the codes carry no text of
/// any message and no identifier, so they may be logged and put in evidence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NotAdoptedReason {
    /// The output qualified but the Human of its own turn did not (K4/3
    /// section 6 makes this unusual). The output is not adopted alone.
    OutputWithoutQualifiedHuman,
    /// The run has no body for a candidate of the turn: its budget could not
    /// pay for it, its row is gone, or no material was handed on.
    BodyUnavailable,
    /// The message the run read is not the one the candidate named, or is not
    /// the kind of message the candidate stands for.
    MessageBindingMismatch,
    /// A body that is blank.
    BodyEmpty,
    /// A body over [`AdoptionLimits::max_message_bytes`].
    BodyOverMessageLimit,
    /// (b) A Human without an output, repeated word for word by the user
    /// message after it.
    RetryDuplicateHuman,
    /// The window already holds [`AdoptionLimits::max_turns`] turns.
    OverTurnLimit,
    /// The turn would take the window past [`AdoptionLimits::max_messages`].
    OverMessageLimit,
    /// The turn would take the window past the history's token budget.
    OverTokenBudget,
    /// The parent of the turn's output, with those already in the window, is
    /// more than the create can read back.
    OverParentReadBudget,
    /// An older turn than the one that ended the window.
    BeyondWindowEnd,
}

impl NotAdoptedReason {
    /// The closed code of the reason.
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::OutputWithoutQualifiedHuman => "output-without-qualified-human",
            Self::BodyUnavailable => "body-unavailable",
            Self::MessageBindingMismatch => "message-binding-mismatch",
            Self::BodyEmpty => "body-empty",
            Self::BodyOverMessageLimit => "body-over-message-limit",
            Self::RetryDuplicateHuman => "retry-duplicate-human",
            Self::OverTurnLimit => "over-turn-limit",
            Self::OverMessageLimit => "over-message-limit",
            Self::OverTokenBudget => "over-token-budget",
            Self::OverParentReadBudget => "over-parent-read-budget",
            Self::BeyondWindowEnd => "beyond-window-end",
        }
    }
}

/// A turn that is not in the request, and why.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NotAdopted {
    pub attempt_id: AttemptId,
    pub reason: NotAdoptedReason,
}

/// One message of an adopted turn: the input row the new attempt stores for it
/// and the body to render.
#[derive(Clone, Eq, PartialEq)]
pub(crate) struct AdoptedMessage {
    /// The attempt whose turn the message belongs to.
    pub attempt_id: AttemptId,
    /// The input row: a past Human is `User` with no parent attempt, a generated
    /// output is `Assistant` with the attempt that made it, both
    /// [`InputUse::AdoptedHistory`].
    pub input: InputReference,
    /// The verified digest of the message version.
    pub body_digest: String,
    pub body: String,
    /// Tokens of the message in the request: its text and its envelope.
    pub tokens: usize,
}

/// Like [`HistoryMessageMaterial`], the body is not shown by `{:?}`: its length
/// and digest are.
impl std::fmt::Debug for AdoptedMessage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AdoptedMessage")
            .field("attempt_id", &self.attempt_id)
            .field("input", &self.input)
            .field("body_digest", &self.body_digest)
            .field("body_bytes", &self.body.len())
            .field("tokens", &self.tokens)
            .finish_non_exhaustive()
    }
}

/// One adopted turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AdoptedTurn {
    pub attempt_id: AttemptId,
    pub created_at_ms: i64,
    pub human: AdoptedMessage,
    pub output: Option<AdoptedMessage>,
    /// (c) The attempt recorded a Scene body digest that is not the body's
    /// digest now.
    pub scene_body_changed: bool,
}

impl AdoptedTurn {
    fn tokens(&self) -> usize {
        self.human.tokens + self.output.as_ref().map_or(0, |output| output.tokens)
    }

    fn message_count(&self) -> usize {
        1 + usize::from(self.output.is_some())
    }

    /// The messages of the turn in the order they are rendered.
    pub(crate) fn messages(&self) -> impl Iterator<Item = &AdoptedMessage> {
        std::iter::once(&self.human).chain(self.output.as_ref())
    }
}

/// The adopted history of one turn: the turns oldest first (the order they are
/// rendered and stored), and the turns that were not adopted.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct HistoryAdoption {
    pub turns: Vec<AdoptedTurn>,
    /// Every qualified turn that is not in `turns`, newest first.
    pub not_adopted: Vec<NotAdopted>,
}

impl HistoryAdoption {
    /// The adopted messages in the order they are rendered.
    pub(crate) fn messages(&self) -> impl Iterator<Item = &AdoptedMessage> {
        self.turns.iter().flat_map(AdoptedTurn::messages)
    }

    pub(crate) fn message_count(&self) -> usize {
        self.turns.iter().map(AdoptedTurn::message_count).sum()
    }

    /// Tokens the adopted messages take in the request.
    pub(crate) fn tokens(&self) -> usize {
        self.turns.iter().map(AdoptedTurn::tokens).sum()
    }

    /// (c) How many adopted replies were written against a Scene body that has
    /// since changed. An observation for tests and evidence.
    pub(crate) fn changed_body_replies(&self) -> usize {
        self.turns
            .iter()
            .filter(|turn| turn.output.is_some() && turn.scene_body_changed)
            .count()
    }

    /// The closed code a turn was left out with, when it was.
    #[cfg(test)]
    pub(crate) fn reason_for(&self, attempt_id: &str) -> Option<NotAdoptedReason> {
        self.not_adopted
            .iter()
            .find(|entry| entry.attempt_id == attempt_id)
            .map(|entry| entry.reason)
    }
}

/// What the adoption is asked about.
pub(crate) struct HistoryAdoptionRequest<'a> {
    /// The run's outcome for this turn.
    pub outcome: &'a SessionHistoryOutcome,
    /// The body of the current Human, the user message that follows the
    /// history in the request ((b) compares against it).
    pub current_human_body: &'a str,
    /// The digest of the target Scene's body now ((c)).
    pub current_scene_body_digest: &'a str,
    pub limits: AdoptionLimits,
}

/// A turn whose messages are usable, before the window is chosen.
struct Usable {
    attempt_id: AttemptId,
    created_at_ms: i64,
    human: AdoptedMessage,
    output: Option<AdoptedMessage>,
    scene_body_changed: bool,
}

/// The qualified candidates of one attempt.
#[derive(Default)]
struct AttemptCandidates<'a> {
    human: Option<&'a SessionCandidateResult>,
    output: Option<&'a SessionCandidateResult>,
}

/// Choose the turns of the final request. Deterministic: the same outcome and
/// request give the same turns in the same order. The only error is the
/// caller's own (`parent_read_cost`, a read of the stored attempt's size).
///
/// `parent_read_cost` is called for the attempt of an output the window is
/// about to take, newest turn first, and not for anything else.
pub(crate) fn adopt_history_turns(
    request: &HistoryAdoptionRequest<'_>,
    parent_read_cost: &mut dyn FnMut(&str) -> Result<ParentReadCost>,
) -> Result<HistoryAdoption> {
    let limits = request.limits;
    let mut not_adopted: Vec<NotAdopted> = Vec::new();

    // 1. The qualified candidates, by attempt.
    let mut by_attempt: BTreeMap<&str, AttemptCandidates<'_>> = BTreeMap::new();
    for result in request.outcome.candidates.iter() {
        if result.disposition != CandidateDisposition::Qualified {
            continue;
        }
        let entry = by_attempt.entry(result.attempt_id.as_str()).or_default();
        match result.kind {
            SessionCandidateKind::PastHuman => entry.human = Some(result),
            SessionCandidateKind::GeneratedOutput => entry.output = Some(result),
            SessionCandidateKind::Attempt => {}
        }
    }

    // 2. The turns whose own messages are usable.
    let mut usable: Vec<Usable> = Vec::new();
    // The turns that cannot be adopted for their own messages, with the place
    // they would have had in the order (creation time, then attempt ID bytes).
    let mut unusable: Vec<(i64, AttemptId)> = Vec::new();
    for (attempt_id, candidates) in by_attempt {
        let Some(human) = candidates.human else {
            if candidates.output.is_some() {
                not_adopted.push(NotAdopted {
                    attempt_id: attempt_id.to_owned(),
                    reason: NotAdoptedReason::OutputWithoutQualifiedHuman,
                });
            }
            continue;
        };
        match usable_turn(request, human, candidates.output) {
            Ok(turn) => usable.push(turn),
            Err(reason) => {
                // Without the attempt's material its place is unknown: newest.
                let created_at_ms = request
                    .outcome
                    .materials
                    .get(attempt_id)
                    .map_or(i64::MAX, |material| material.created_at_ms);
                unusable.push((created_at_ms, attempt_id.to_owned()));
                not_adopted.push(NotAdopted {
                    attempt_id: attempt_id.to_owned(),
                    reason,
                });
            }
        }
    }
    // The newest of them ends the window: nothing older than it is adopted.
    let window_cutoff: Option<(i64, AttemptId)> = unusable
        .into_iter()
        .max_by(|left, right| (left.0, left.1.as_bytes()).cmp(&(right.0, right.1.as_bytes())));
    // Oldest first: the attempt's creation time, then the attempt ID's bytes.
    usable.sort_by(|left, right| {
        (left.created_at_ms, left.attempt_id.as_bytes())
            .cmp(&(right.created_at_ms, right.attempt_id.as_bytes()))
    });

    // 3. (b) A Human without an output, repeated by the user message after it.
    // The message after a turn is the next turn that is kept, or the current
    // Human; equal text makes the dropped ones agree with each other too.
    let mut keep = vec![true; usable.len()];
    let mut following_user_body: &str = request.current_human_body;
    for (index, turn) in usable.iter().enumerate().rev() {
        if turn.output.is_none() && turn.human.body == following_user_body {
            keep[index] = false;
            not_adopted.push(NotAdopted {
                attempt_id: turn.attempt_id.clone(),
                reason: NotAdoptedReason::RetryDuplicateHuman,
            });
        } else {
            following_user_body = turn.human.body.as_str();
        }
    }
    // Newest first.
    let retained: Vec<Usable> = usable
        .into_iter()
        .zip(keep)
        .rev()
        .filter_map(|(turn, kept)| kept.then_some(turn))
        .collect();

    // 4. The window: the newest turns that all fit (`retained` is newest
    // first), with the first misfit ending it.
    let mut window: Vec<AdoptedTurn> = Vec::new();
    let (mut messages, mut tokens) = (0usize, 0usize);
    let (mut parent_rows, mut parent_bytes) = (0usize, 0usize);
    let mut ended = false;
    for turn in retained {
        if !ended {
            if let Some((cutoff_ms, cutoff_id)) = &window_cutoff {
                // At or before the turn that could not be adopted: the window
                // ends before it (its own reason is already recorded).
                ended = (turn.created_at_ms, turn.attempt_id.as_bytes())
                    < (*cutoff_ms, cutoff_id.as_bytes());
            }
        }
        if ended {
            not_adopted.push(NotAdopted {
                attempt_id: turn.attempt_id,
                reason: NotAdoptedReason::BeyondWindowEnd,
            });
            continue;
        }
        let turn_messages = 1 + usize::from(turn.output.is_some());
        let turn_tokens =
            turn.human.tokens + turn.output.as_ref().map_or(0, |output| output.tokens);
        let misfit = if window.len() >= limits.max_turns {
            Some(NotAdoptedReason::OverTurnLimit)
        } else if messages + turn_messages > limits.max_messages {
            Some(NotAdoptedReason::OverMessageLimit)
        } else if tokens.saturating_add(turn_tokens) > limits.token_budget {
            Some(NotAdoptedReason::OverTokenBudget)
        } else {
            None
        };
        let mut parent_cost = ParentReadCost::default();
        let misfit = match misfit {
            Some(reason) => Some(reason),
            None if turn.output.is_some() => {
                parent_cost = parent_read_cost(&turn.attempt_id)?;
                match (
                    parent_rows.checked_add(parent_cost.rows),
                    parent_bytes.checked_add(parent_cost.bytes),
                ) {
                    (Some(rows), Some(bytes))
                        if rows <= limits.parent_read_rows && bytes <= limits.parent_read_bytes =>
                    {
                        None
                    }
                    _ => Some(NotAdoptedReason::OverParentReadBudget),
                }
            }
            None => None,
        };
        if let Some(reason) = misfit {
            ended = true;
            not_adopted.push(NotAdopted {
                attempt_id: turn.attempt_id,
                reason,
            });
            continue;
        }
        messages += turn_messages;
        tokens += turn_tokens;
        parent_rows += parent_cost.rows;
        parent_bytes += parent_cost.bytes;
        window.push(AdoptedTurn {
            attempt_id: turn.attempt_id,
            created_at_ms: turn.created_at_ms,
            human: turn.human,
            output: turn.output,
            scene_body_changed: turn.scene_body_changed,
        });
    }
    window.reverse();
    Ok(HistoryAdoption {
        turns: window,
        not_adopted,
    })
}

/// The turn of a qualified past Human and the output of its attempt, when that
/// qualified, from the material the run handed on; or why it is not usable.
fn usable_turn(
    request: &HistoryAdoptionRequest<'_>,
    human: &SessionCandidateResult,
    output: Option<&SessionCandidateResult>,
) -> std::result::Result<Usable, NotAdoptedReason> {
    let attempt_id = human.attempt_id.as_str();
    let material = request
        .outcome
        .materials
        .get(attempt_id)
        .ok_or(NotAdoptedReason::BodyUnavailable)?;
    let human_message = adopted_message(request, attempt_id, human, material.human.as_ref())?;
    let output_message = output
        .map(|output| adopted_message(request, attempt_id, output, material.output.as_ref()))
        .transpose()?;
    Ok(Usable {
        attempt_id: attempt_id.to_owned(),
        created_at_ms: material.created_at_ms,
        human: human_message,
        output: output_message,
        scene_body_changed: material.scene_body_digest != request.current_scene_body_digest,
    })
}

/// One candidate's message: the body the run read, if it is the message the
/// candidate named and can be put in the request as it is.
fn adopted_message(
    request: &HistoryAdoptionRequest<'_>,
    attempt_id: &str,
    candidate: &SessionCandidateResult,
    material: Option<&HistoryMessageMaterial>,
) -> std::result::Result<AdoptedMessage, NotAdoptedReason> {
    let material = material.ok_or(NotAdoptedReason::BodyUnavailable)?;
    let (role, origin, parent_attempt_id) = match candidate.kind {
        SessionCandidateKind::PastHuman => (InputRole::User, MessageOrigin::Human, None),
        SessionCandidateKind::GeneratedOutput => (
            InputRole::Assistant,
            MessageOrigin::Generated,
            Some(attempt_id.to_owned()),
        ),
        SessionCandidateKind::Attempt => return Err(NotAdoptedReason::MessageBindingMismatch),
    };
    if candidate.version_id.as_deref() != Some(material.version_id.as_str())
        || material.origin != origin
        || material.parent_attempt_id != parent_attempt_id
        || material.body_digest.is_empty()
    {
        return Err(NotAdoptedReason::MessageBindingMismatch);
    }
    if material.body.trim().is_empty() {
        return Err(NotAdoptedReason::BodyEmpty);
    }
    if material.body.len() > request.limits.max_message_bytes {
        return Err(NotAdoptedReason::BodyOverMessageLimit);
    }
    Ok(AdoptedMessage {
        attempt_id: attempt_id.to_owned(),
        input: InputReference {
            role,
            target: InputTarget::Message {
                version_id: material.version_id.clone(),
                parent_attempt_id,
            },
            input_use: InputUse::AdoptedHistory,
        },
        body_digest: material.body_digest.clone(),
        tokens: request
            .limits
            .message_envelope_tokens
            .saturating_add(estimate_nir1_context_tokens(&material.body)),
        body: material.body.clone(),
    })
}

#[cfg(test)]
#[path = "nir1_history_adoption_tests.rs"]
mod tests;
