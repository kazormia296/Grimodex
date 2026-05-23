import { invoke } from "@/lib/tauri";
import type { ExternalRoot, ScanResult } from "./types";

export async function registerMount(
  rootId: string,
  path: string,
  label: string,
): Promise<ScanResult> {
  return invoke<ScanResult>("external_mount_register", { rootId, path, label });
}

export async function unregisterMount(rootId: string): Promise<void> {
  return invoke("external_mount_unregister", { rootId });
}

export async function readExternalFile(
  rootId: string,
  relPath: string,
): Promise<string> {
  return invoke<string>("external_mount_read_file", { rootId, relPath });
}

export async function writeExternalFile(
  rootId: string,
  relPath: string,
  content: string,
): Promise<void> {
  return invoke("external_mount_write_file", { rootId, relPath, content });
}

export async function listRegisteredMounts(): Promise<ExternalRoot[]> {
  return invoke<ExternalRoot[]>("external_mount_list");
}

export async function getExternalFileMtime(
  rootId: string,
  relPath: string,
): Promise<string> {
  return invoke<string>("external_mount_file_mtime", { rootId, relPath });
}

export async function scanMount(rootId: string): Promise<ScanResult> {
  return invoke<ScanResult>("external_mount_scan", { rootId });
}
