'use client';
import { useEffect, useState } from "react";
import EditorComponent from "../../components/EditorComponent";

type Props = {
  params: Promise<{ roomId: string }>;
};

export default function RoomPage({ params }: Props) {
  const [roomId, setRoomId] = useState<string>("");

  useEffect(() => {
    // Unwrap params (required in Next.js 15+)
    params.then((resolvedParams) => {
      setRoomId(resolvedParams.roomId);
    });
  }, [params]);

  if (!roomId) {
    return <div className="flex items-center justify-center h-screen">Loading room...</div>;
  }

  return (
    <div className="h-screen">
      <EditorComponent roomId={roomId} />
    </div>
  );
}