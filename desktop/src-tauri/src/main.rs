// Nessuna finestra di console dietro l'app nella build di produzione.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    medsystem_gineco_lib::run()
}
