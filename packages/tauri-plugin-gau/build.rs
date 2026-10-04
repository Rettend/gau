const COMMANDS: &[&str] = &[
    "chatgpt_prepare",
    "chatgpt_sign_in",
    "chatgpt_list_accounts",
    "chatgpt_sign_out",
    "chatgpt_cancel",
    "chatgpt_fetch",
    "chatgpt_ack",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
