/**
 * Reading a selection out of the composer's hidden file input.
 *
 * The Attach button is drag-and-drop's discoverable twin — what the picker
 * returns is handed to the exact code a drop runs — so the only thing this
 * module owes the composer is the reset a naive `input.files` read forgets.
 *
 * @module composerFilePicker
 */

/**
 * The picked files, with the input emptied so the next pick still fires.
 *
 * A file input raises no `change` event when the user re-picks the file
 * already sitting in its `value`: attaching `report.pdf`, then attaching
 * `report.pdf` again, would silently do nothing. The reset runs on every
 * call, a cancelled selection included, because a cancel leaves the previous
 * value in place to block the same re-pick.
 */
export function takeFilesFromInput(input: HTMLInputElement): File[] {
  const files = Array.from(input.files ?? []);
  input.value = "";
  return files;
}
