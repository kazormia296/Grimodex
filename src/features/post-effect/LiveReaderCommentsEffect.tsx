import type { LiveReaderCommentsParams } from "./useLiveReaderComments";
import { useLiveReaderComments } from "./useLiveReaderComments";

export default function LiveReaderCommentsEffect(
  props: LiveReaderCommentsParams,
): null {
  useLiveReaderComments(props);
  return null;
}
