//! Shared Chronicle timestamp invariants for every native write surface.
//!
//! Chronicle persists a day and an optional minute separately. Writers must
//! validate the complete post-write tuple so a partial update cannot hide an
//! invalid minute or move an interval end before its start.

use std::fmt;

use thiserror::Error;

pub const MINUTES_PER_DAY: i64 = 1_440;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChronicleEndpoint {
    Start,
    End,
}

impl fmt::Display for ChronicleEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Start => f.write_str("start"),
            Self::End => f.write_str("end"),
        }
    }
}

/// One persisted Chronicle endpoint after create defaults or an update patch
/// have been applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChronicleTimestamp<'a> {
    pub day: Option<i64>,
    pub minute: Option<i64>,
    pub granularity: &'a str,
}

/// The complete persisted date range after a write has been merged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChronicleDateRange<'a> {
    pub start: ChronicleTimestamp<'a>,
    pub end: ChronicleTimestamp<'a>,
}

/// Resolve an omitted granularity without overriding an explicit caller
/// choice. A written minute promotes the endpoint to `time`; a written day
/// creates a `day` endpoint only when the current endpoint is absent.
///
/// Passing `"none"` as `current` gives the create-default behavior.
pub fn resolve_chronicle_granularity<'a>(
    explicit: Option<&'a str>,
    current: &'a str,
    writes_day: bool,
    writes_minute: bool,
) -> &'a str {
    match explicit {
        Some(granularity) => granularity,
        None if writes_minute => "time",
        None if writes_day && current == "none" => "day",
        None => current,
    }
}

/// Canonicalize one Chronicle endpoint before it is persisted.
///
/// Only `time` granularity owns a minute. `none` additionally means that the
/// endpoint has no day. Callers updating an existing row should apply this
/// helper only when that endpoint's granularity is explicitly written; this
/// preserves legacy coarse-granularity rows during unrelated updates.
pub fn normalize_chronicle_timestamp(timestamp: ChronicleTimestamp<'_>) -> ChronicleTimestamp<'_> {
    match timestamp.granularity {
        "time" => timestamp,
        "none" => ChronicleTimestamp {
            day: None,
            minute: None,
            granularity: timestamp.granularity,
        },
        _ => ChronicleTimestamp {
            minute: None,
            ..timestamp
        },
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ChronicleDateRangeError {
    #[error("chronicle {endpoint} minute must be between 0 and 1439, got {minute}")]
    MinuteOutOfRange {
        endpoint: ChronicleEndpoint,
        minute: i64,
    },
    #[error("chronicle {endpoint} time granularity requires both a day and a minute")]
    IncompleteTime { endpoint: ChronicleEndpoint },
    #[error("chronicle {endpoint} granularity '{granularity}' is not supported")]
    InvalidGranularity {
        endpoint: ChronicleEndpoint,
        granularity: String,
    },
    #[error("chronicle {endpoint} granularity '{granularity}' requires a day")]
    MissingDay {
        endpoint: ChronicleEndpoint,
        granularity: String,
    },
    #[error("chronicle {endpoint} granularity '{granularity}' does not allow a minute")]
    UnexpectedMinute {
        endpoint: ChronicleEndpoint,
        granularity: String,
    },
    #[error("chronicle {endpoint} granularity 'none' requires both day and minute to be absent")]
    NonCanonicalNone { endpoint: ChronicleEndpoint },
    #[error("chronicle end endpoint requires a start endpoint")]
    EndWithoutStart,
    #[error(
        "chronicle end timestamp ({end_day}, {end_minute}) must not precede start timestamp ({start_day}, {start_minute})"
    )]
    EndBeforeStart {
        start_day: i64,
        start_minute: i64,
        end_day: i64,
        end_minute: i64,
    },
}

fn validate_endpoint(
    endpoint: ChronicleEndpoint,
    timestamp: ChronicleTimestamp<'_>,
) -> Result<(), ChronicleDateRangeError> {
    if timestamp.granularity == "time" {
        if let Some(minute) = timestamp.minute {
            if !(0..MINUTES_PER_DAY).contains(&minute) {
                return Err(ChronicleDateRangeError::MinuteOutOfRange { endpoint, minute });
            }
        }

        if timestamp.day.is_none() || timestamp.minute.is_none() {
            return Err(ChronicleDateRangeError::IncompleteTime { endpoint });
        }
    }

    Ok(())
}

/// Compatibility validation for existing Chronicle timestamp tuples. Legacy
/// coarse-granularity minutes are ignored as non-semantic; `time` minutes are
/// validated and participate in ordering. `i128` avoids overflow for arbitrary
/// persisted i64 day values.
pub fn validate_chronicle_date_range(
    range: ChronicleDateRange<'_>,
) -> Result<(), ChronicleDateRangeError> {
    validate_endpoint(ChronicleEndpoint::Start, range.start)?;
    validate_endpoint(ChronicleEndpoint::End, range.end)?;

    if let (Some(start_day), Some(end_day)) = (range.start.day, range.end.day) {
        let start_minute = if range.start.granularity == "time" {
            range.start.minute.unwrap_or(0)
        } else {
            0
        };
        let end_minute = if range.end.granularity == "time" {
            range.end.minute.unwrap_or(0)
        } else {
            0
        };
        let start_absolute =
            i128::from(start_day) * i128::from(MINUTES_PER_DAY) + i128::from(start_minute);
        let end_absolute =
            i128::from(end_day) * i128::from(MINUTES_PER_DAY) + i128::from(end_minute);
        if end_absolute < start_absolute {
            return Err(ChronicleDateRangeError::EndBeforeStart {
                start_day,
                start_minute,
                end_day,
                end_minute,
            });
        }
    }

    Ok(())
}

fn validate_canonical_endpoint(
    endpoint: ChronicleEndpoint,
    timestamp: ChronicleTimestamp<'_>,
) -> Result<(), ChronicleDateRangeError> {
    match timestamp.granularity {
        "none" if timestamp.day.is_some() || timestamp.minute.is_some() => {
            Err(ChronicleDateRangeError::NonCanonicalNone { endpoint })
        }
        "none" => Ok(()),
        "season" | "year" | "month" | "day" if timestamp.day.is_none() => {
            Err(ChronicleDateRangeError::MissingDay {
                endpoint,
                granularity: timestamp.granularity.to_string(),
            })
        }
        "season" | "year" | "month" | "day" if timestamp.minute.is_some() => {
            Err(ChronicleDateRangeError::UnexpectedMinute {
                endpoint,
                granularity: timestamp.granularity.to_string(),
            })
        }
        "season" | "year" | "month" | "day" | "time" => Ok(()),
        granularity => Err(ChronicleDateRangeError::InvalidGranularity {
            endpoint,
            granularity: granularity.to_string(),
        }),
    }
}

/// Validate the strict persistence matrix after normalization:
///
/// - `none`: no day and no minute
/// - `season`/`year`/`month`/`day`: day and no minute
/// - `time`: day and minute
/// - a present end endpoint requires a present start endpoint
///
/// Existing rows may predate this matrix. Unrelated writes should use
/// [`validate_chronicle_date_range`] for compatibility instead.
pub fn validate_canonical_chronicle_date_range(
    range: ChronicleDateRange<'_>,
) -> Result<(), ChronicleDateRangeError> {
    validate_chronicle_date_range(range)?;
    validate_canonical_endpoint(ChronicleEndpoint::Start, range.start)?;
    validate_canonical_endpoint(ChronicleEndpoint::End, range.end)?;

    if range.end.granularity != "none" && range.start.granularity == "none" {
        return Err(ChronicleDateRangeError::EndWithoutStart);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timestamp(
        day: Option<i64>,
        minute: Option<i64>,
        granularity: &str,
    ) -> ChronicleTimestamp<'_> {
        ChronicleTimestamp {
            day,
            minute,
            granularity,
        }
    }

    #[test]
    fn rejects_minutes_outside_the_persisted_range() {
        for minute in [-1, MINUTES_PER_DAY] {
            let error = validate_chronicle_date_range(ChronicleDateRange {
                start: timestamp(Some(10), Some(minute), "time"),
                end: timestamp(None, None, "none"),
            })
            .expect_err("invalid minute");
            assert_eq!(
                error,
                ChronicleDateRangeError::MinuteOutOfRange {
                    endpoint: ChronicleEndpoint::Start,
                    minute,
                }
            );
        }
    }

    #[test]
    fn accepts_minute_boundaries_and_equal_endpoints() {
        for minute in [0, MINUTES_PER_DAY - 1] {
            validate_chronicle_date_range(ChronicleDateRange {
                start: timestamp(Some(10), Some(minute), "time"),
                end: timestamp(Some(10), Some(minute), "time"),
            })
            .expect("minute boundaries and equal endpoints are valid");
        }
    }

    #[test]
    fn rejects_same_day_end_before_start() {
        let error = validate_chronicle_date_range(ChronicleDateRange {
            start: timestamp(Some(10), Some(18 * 60), "time"),
            end: timestamp(Some(10), Some(12 * 60), "time"),
        })
        .expect_err("reversed interval");
        assert!(matches!(
            error,
            ChronicleDateRangeError::EndBeforeStart { .. }
        ));
    }

    #[test]
    fn time_granularity_requires_a_complete_timestamp() {
        for incomplete in [
            timestamp(None, Some(60), "time"),
            timestamp(Some(10), None, "time"),
        ] {
            let error = validate_chronicle_date_range(ChronicleDateRange {
                start: incomplete,
                end: timestamp(None, None, "none"),
            })
            .expect_err("incomplete time timestamp");
            assert!(matches!(
                error,
                ChronicleDateRangeError::IncompleteTime {
                    endpoint: ChronicleEndpoint::Start
                }
            ));
        }

        for incomplete in [
            timestamp(None, Some(60), "time"),
            timestamp(Some(10), None, "time"),
        ] {
            let error = validate_chronicle_date_range(ChronicleDateRange {
                start: timestamp(None, None, "none"),
                end: incomplete,
            })
            .expect_err("incomplete end time timestamp");
            assert!(matches!(
                error,
                ChronicleDateRangeError::IncompleteTime {
                    endpoint: ChronicleEndpoint::End
                }
            ));
        }
    }

    #[test]
    fn normalization_clears_minutes_from_non_time_granularities() {
        assert_eq!(
            normalize_chronicle_timestamp(timestamp(Some(10), Some(18 * 60), "day")),
            timestamp(Some(10), None, "day")
        );
        assert_eq!(
            normalize_chronicle_timestamp(timestamp(Some(10), Some(18 * 60), "none")),
            timestamp(None, None, "none")
        );
        assert_eq!(
            normalize_chronicle_timestamp(timestamp(Some(10), Some(18 * 60), "time")),
            timestamp(Some(10), Some(18 * 60), "time")
        );
    }

    #[test]
    fn omitted_granularity_is_inferred_without_overriding_explicit_values() {
        assert_eq!(
            resolve_chronicle_granularity(None, "none", true, false),
            "day"
        );
        assert_eq!(
            resolve_chronicle_granularity(None, "day", false, true),
            "time"
        );
        assert_eq!(
            resolve_chronicle_granularity(None, "time", true, false),
            "time"
        );
        assert_eq!(
            resolve_chronicle_granularity(Some("none"), "time", true, true),
            "none"
        );
    }

    #[test]
    fn canonical_validation_enforces_endpoint_matrix_and_start_ownership() {
        for granularity in ["season", "year", "month", "day"] {
            validate_canonical_chronicle_date_range(ChronicleDateRange {
                start: timestamp(Some(10), None, granularity),
                end: timestamp(None, None, "none"),
            })
            .expect("coarse endpoint with a day");

            assert!(matches!(
                validate_canonical_chronicle_date_range(ChronicleDateRange {
                    start: timestamp(None, None, granularity),
                    end: timestamp(None, None, "none"),
                }),
                Err(ChronicleDateRangeError::MissingDay {
                    endpoint: ChronicleEndpoint::Start,
                    ..
                })
            ));
            assert!(matches!(
                validate_canonical_chronicle_date_range(ChronicleDateRange {
                    start: timestamp(Some(10), Some(60), granularity),
                    end: timestamp(None, None, "none"),
                }),
                Err(ChronicleDateRangeError::UnexpectedMinute {
                    endpoint: ChronicleEndpoint::Start,
                    ..
                })
            ));
        }

        assert_eq!(
            validate_canonical_chronicle_date_range(ChronicleDateRange {
                start: timestamp(None, None, "none"),
                end: timestamp(Some(10), None, "day"),
            }),
            Err(ChronicleDateRangeError::EndWithoutStart)
        );
    }

    #[test]
    fn preserves_legacy_minutes_at_coarser_granularities() {
        validate_chronicle_date_range(ChronicleDateRange {
            start: timestamp(Some(10), Some(18 * 60), "month"),
            end: timestamp(Some(10), Some(12 * 60), "day"),
        })
        .expect("legacy non-time minutes remain compatible and do not affect ordering");
    }
}
