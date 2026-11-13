import { redirect } from "next/navigation";

/** Machines live in Settings → Machines & devices (R25g, Q62); the old URL still lands there. */
export default function MachinesPage() {
  redirect("/settings#machines");
}
