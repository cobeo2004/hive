import { newKeyPair } from "../lib/creds";

// Prints a new key pair for sealed agent credentials: HIVE_CREDS_PUBLIC_KEY goes in the panel's env,
// HIVE_CREDS_PRIVATE_KEY in every runner's. Newlines are escaped so each fits one .env line.
const { publicKey, privateKey } = newKeyPair();
const line = (name: string, pem: string) => `${name}="${pem.trim().replace(/\n/g, "\\n")}"`;
console.log(line("HIVE_CREDS_PUBLIC_KEY", publicKey));
console.log(line("HIVE_CREDS_PRIVATE_KEY", privateKey));
