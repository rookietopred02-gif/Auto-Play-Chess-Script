mod macros;
mod uci;
mod utils;

use std::{
    env,
    sync::{Arc, Mutex},
};

use actix_web::{get, rt::time::Instant, web, App, HttpResponse, HttpServer, Responder};
use macros::styled::f;
use rfd::FileDialog;
use shakmaty::fen::Fen;
use uci::Engine;
use utils::{
    color_print::{CommonColors, Printer},
    engine::{choose_engine_settings, initialize_engine},
    print_err_and_quit, SolveQueryParams, SolveResponse, DEFAULT_DEPTH, DEFAULT_MAX_THINK_TIME_MS,
    MAX_DEPTH, MAX_MAX_THINK_TIME_MS, MIN_DEPTH, MIN_MAX_THINK_TIME_MS,
};

const DEFAULT_BIND_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 3000;

struct AppState {
    engine: Arc<Mutex<Engine>>,
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    Printer::println("If anything goes wrong please try updating the app first. If that doesn't work, please report the issue on GitHub or DM me on Discord (in my github profile).\n", CommonColors::BrightCyan);

    let stockfish_path = resolve_stockfish_path();
    let (hash, threads, syzygy) = resolve_engine_settings();
    let (host, port) = resolve_bind_address();

    let engine = initialize_engine(&stockfish_path, &hash, &threads, &syzygy);
    set_stockfish_option(&engine, "MultiPV", "1");

    Printer::println(
        f!("\nServer started at http://{host}:{port}\n"),
        CommonColors::BrightGreen,
    );

    let engine_data = web::Data::new(AppState {
        engine: Arc::new(Mutex::new(engine)),
    });

    HttpServer::new(move || {
        App::new()
            .app_data(engine_data.clone())
            .service(health)
            .service(solve)
    })
    .bind((host.as_str(), port))?
    .run()
    .await
}

fn resolve_stockfish_path() -> String {
    if let Ok(path) = env::var("STOCKFISH_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            Printer::println(
                "Using STOCKFISH_PATH from environment.",
                CommonColors::BrightCyan,
            );
            return trimmed.to_string();
        }
    }

    choose_stockfish_file()
}

fn parse_env_int(key: &str) -> Option<i32> {
    let value = env::var(key).ok()?;
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return None;
    }

    match trimmed.parse::<i32>() {
        Ok(parsed) => Some(parsed),
        Err(_) => {
            Printer::println(
                f!("Invalid value for {key}: '{trimmed}'. Ignoring it."),
                CommonColors::Red,
            );
            None
        }
    }
}

fn resolve_engine_settings() -> (Option<i32>, Option<i32>, String) {
    let hash = parse_env_int("STOCKFISH_HASH_MB");
    let threads = parse_env_int("STOCKFISH_THREADS");
    let syzygy = env::var("STOCKFISH_SYZYGY_PATH").unwrap_or_default();

    if hash.is_some() || threads.is_some() || !syzygy.is_empty() {
        Printer::println(
            "Using STOCKFISH_* engine settings from environment.",
            CommonColors::BrightCyan,
        );
        (hash, threads, syzygy)
    } else {
        choose_engine_settings()
    }
}

fn resolve_bind_address() -> (String, u16) {
    let host = env::var("SERVER_HOST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BIND_HOST.to_string());

    let raw_port = env::var("PORT")
        .ok()
        .or_else(|| env::var("SERVER_PORT").ok());

    let port = match raw_port {
        Some(value) => match value.parse::<u16>() {
            Ok(parsed) => parsed,
            Err(_) => {
                Printer::println(
                    f!("Invalid port '{value}'. Falling back to {DEFAULT_PORT}."),
                    CommonColors::Red,
                );
                DEFAULT_PORT
            }
        },
        None => DEFAULT_PORT,
    };

    (host, port)
}

fn set_stockfish_option(engine: &Engine, option: &str, value: &str) {
    engine
        .set_option(option, value)
        .unwrap_or_else(|e| Printer::println(f!("Failed to set option: {e}"), CommonColors::Red));
}

fn choose_stockfish_file() -> String {
    println!("Choose file for Stockfish.");
    #[cfg(target_os = "windows")]
    let stockfish_path = FileDialog::new()
        .set_title("Choose location of Stockfish")
        .add_filter("Executable (*.exe)", &["exe"])
        .pick_file();

    #[cfg(target_os = "macos")]
    let stockfish_path = FileDialog::new()
        .set_title("Choose location for Stockfish")
        .pick_file();

    if stockfish_path.is_none() {
        print_err_and_quit("Please select a file. Restart the program and select the Stockfish executable to continue.");
    }

    #[cfg(target_os = "macos")]
    if !utils::os::is_executable(stockfish_path.as_ref().unwrap()) {
        print_err_and_quit("Invalid file selected. Restart the program and select the Stockfish executable to continue.");
    }

    Printer::println("File chosen successfully!\n", CommonColors::BrightGreen);

    stockfish_path.unwrap().display().to_string()
}

fn bad_request(code: &str, message: impl Into<String>) -> HttpResponse {
    HttpResponse::BadRequest().json(SolveResponse {
        success: false,
        result: message.into(),
        code: Some(code.to_string()),
        elapsed_ms: None,
    })
}

fn internal_server_error(code: &str, message: impl Into<String>) -> HttpResponse {
    HttpResponse::InternalServerError().json(SolveResponse {
        success: false,
        result: message.into(),
        code: Some(code.to_string()),
        elapsed_ms: None,
    })
}

fn validate_depth(value: Option<u32>) -> Result<u32, HttpResponse> {
    let depth = value.unwrap_or(DEFAULT_DEPTH);

    if !(MIN_DEPTH..=MAX_DEPTH).contains(&depth) {
        return Err(bad_request(
            "invalid_depth",
            f!("depth must be between {MIN_DEPTH} and {MAX_DEPTH}"),
        ));
    }

    Ok(depth)
}

fn validate_max_think_time(value: Option<u32>) -> Result<u32, HttpResponse> {
    let think_time = value.unwrap_or(DEFAULT_MAX_THINK_TIME_MS);

    if !(MIN_MAX_THINK_TIME_MS..=MAX_MAX_THINK_TIME_MS).contains(&think_time) {
        return Err(bad_request(
            "invalid_max_think_time",
            f!("max_think_time must be between {MIN_MAX_THINK_TIME_MS} and {MAX_MAX_THINK_TIME_MS} milliseconds"),
        ));
    }

    Ok(think_time)
}

#[get("/health")]
async fn health() -> impl Responder {
    HttpResponse::Ok().json(SolveResponse {
        success: true,
        result: "ok".to_string(),
        code: None,
        elapsed_ms: None,
    })
}

#[get("/api/solve")]
async fn solve(data: web::Data<AppState>, query: web::Query<SolveQueryParams>) -> impl Responder {
    let depth = match validate_depth(query.depth) {
        Ok(value) => value,
        Err(response) => return response,
    };

    let max_think_time = match validate_max_think_time(query.max_think_time) {
        Ok(value) => value,
        Err(response) => return response,
    };

    let disregard_think_time = query.disregard_think_time.unwrap_or(false);

    Printer::print("FEN", CommonColors::BrightMagenta);
    println!(": {}", query.fen);

    Printer::print("Depth", CommonColors::BrightMagenta);
    println!(": {depth}");

    Printer::print("Max Think Time", CommonColors::BrightMagenta);
    println!(": {max_think_time}");

    Printer::print("Disregard Think Time", CommonColors::BrightMagenta);
    println!(": {disregard_think_time}");

    if query.fen.parse::<Fen>().is_err() {
        Printer::println("Invalid FEN\n", CommonColors::Red);
        return bad_request("invalid_fen", "Error: Invalid FEN");
    }

    let start = Instant::now();

    let mut engine = match data.engine.lock() {
        Ok(value) => value,
        Err(_) => {
            return internal_server_error("engine_lock_failed", "Error: Failed to lock engine")
        }
    };

    if let Err(err) = engine.set_position(query.fen.as_str()) {
        Printer::println(f!("Failed to set position - {err}\n"), CommonColors::Red);
        return internal_server_error(
            "set_position_failed",
            f!("Error: Failed to set position - {}", err),
        );
    }

    engine.movetime(max_think_time);

    let best_move = match engine.bestmove_depth(depth, disregard_think_time) {
        Ok(mv) => mv,
        Err(err) => {
            Printer::println(f!("Failed to get best move - {err}\n"), CommonColors::Red);
            return internal_server_error(
                "best_move_failed",
                f!("Error: Failed to get best move - {}", err),
            );
        }
    };

    let duration = start.elapsed();

    Printer::print("Returned", CommonColors::BrightMagenta);
    println!(": {best_move}");

    Printer::print("Time Taken", CommonColors::BrightMagenta);
    println!(": {duration:?}\n");

    HttpResponse::Ok().json(SolveResponse {
        success: true,
        result: best_move,
        code: None,
        elapsed_ms: Some(duration.as_millis()),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        validate_depth, validate_max_think_time, DEFAULT_DEPTH, DEFAULT_MAX_THINK_TIME_MS,
        MAX_DEPTH, MAX_MAX_THINK_TIME_MS, MIN_DEPTH, MIN_MAX_THINK_TIME_MS,
    };

    #[test]
    fn validate_depth_defaults_and_bounds() {
        assert_eq!(validate_depth(None).ok(), Some(DEFAULT_DEPTH));
        assert_eq!(validate_depth(Some(MIN_DEPTH)).ok(), Some(MIN_DEPTH));
        assert_eq!(validate_depth(Some(MAX_DEPTH)).ok(), Some(MAX_DEPTH));
        assert!(validate_depth(Some(MIN_DEPTH - 1)).is_err());
        assert!(validate_depth(Some(MAX_DEPTH + 1)).is_err());
    }

    #[test]
    fn validate_think_time_defaults_and_bounds() {
        assert_eq!(
            validate_max_think_time(None).ok(),
            Some(DEFAULT_MAX_THINK_TIME_MS)
        );
        assert_eq!(
            validate_max_think_time(Some(MIN_MAX_THINK_TIME_MS)).ok(),
            Some(MIN_MAX_THINK_TIME_MS)
        );
        assert_eq!(
            validate_max_think_time(Some(MAX_MAX_THINK_TIME_MS)).ok(),
            Some(MAX_MAX_THINK_TIME_MS)
        );
        assert!(validate_max_think_time(Some(MIN_MAX_THINK_TIME_MS - 1)).is_err());
        assert!(validate_max_think_time(Some(MAX_MAX_THINK_TIME_MS + 1)).is_err());
    }
}
