// Nessuna finestra di console dietro l'app nella build di produzione.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gynosystem_lib::run()
}
