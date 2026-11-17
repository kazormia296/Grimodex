//! S1-A's tests (design S1A-1 to 26; the ones of the TypeScript side are in
//! `electron/`). `fake` is the Backend of the flow tests, `unit` the pure
//! functions, `flow` the order of the steps, the deadline, the ledger and the
//! tail, `real` the real Backend on a real workspace database.

mod fake;
mod flow;
mod real;
mod unit;
