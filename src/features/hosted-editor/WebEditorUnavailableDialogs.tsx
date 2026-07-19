/**
 * Web Editor-only build replacements for desktop import/export surfaces.
 * The application capability gate never renders these components; the stubs
 * also prevent their desktop implementation chunks from entering Pages.
 */
export function TransferDialog(): null {
  return null;
}

export function ExportDialog(): null {
  return null;
}

export function WebEditorWorkspaceImportDialog(): null {
  return null;
}
