/** Prefix applied to a room id to derive its Yjs document name. */
export const roomDocName = (roomId: string): string => `room-${roomId}`;

/** Message type identifiers of the y-websocket wire protocol. */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;
