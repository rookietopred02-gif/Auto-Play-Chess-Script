pub mod color_print;
pub mod engine;
pub mod input;
pub mod os;

use std::process::{exit, Command};

use color_print::{CommonColors, Printer};
use serde::{Deserialize, Serialize};

pub const DEFAULT_DEPTH: u32 = 17;
pub const MIN_DEPTH: u32 = 1;
pub const MAX_DEPTH: u32 = 50;

pub const DEFAULT_MAX_THINK_TIME_MS: u32 = 100;
pub const MIN_MAX_THINK_TIME_MS: u32 = 10;
pub const MAX_MAX_THINK_TIME_MS: u32 = 60_000;

#[derive(Deserialize, Debug)]
pub struct SolveQueryParams {
    pub fen: String,
    pub max_think_time: Option<u32>,
    pub depth: Option<u32>,
    pub disregard_think_time: Option<bool>,
}

#[derive(Serialize)]
pub struct SolveResponse {
    pub success: bool,
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u128>,
}

pub fn print_err_and_quit(msg: impl Into<String>) {
    Printer::println(msg.into(), CommonColors::Red);

    let _ = Command::new("cmd.exe").arg("/c").arg("pause").status();
    exit(1);
}
