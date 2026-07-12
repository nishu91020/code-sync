'use client';
import { Button, Typography } from "@mui/material";
import { useState } from "react";
import { useRouter } from "next/navigation";

export const CreateRoom = () => {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const createNewRoom = async () => {
    setLoading(true);
    try {
      const response = await fetch("http://localhost:3001/api/room", {
        method: "POST",
      });

      if (!response.ok) throw new Error("Failed to create room");

      const data = await response.json();

      if (data.roomId) {
        router.push(`/room/${data.roomId}`);
      } else {
        alert("Room created but no ID returned");
      }
    } catch (error) {
      console.error(error);
      alert("Failed to create room");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <Typography variant="h5" style={{ fontWeight: "bold", marginBottom: "10px" }}>
        CodeSync
      </Typography>
      <Typography
        variant="subtitle1"
        style={{ fontWeight: "bold", marginBottom: "20px", textAlign: "center", maxWidth: "600px" }}
      >
        Online Live Code Editor with seamless collaboration and real-time code sharing.
      </Typography>

      <Button
        variant="contained"
        onClick={createNewRoom}
        disabled={loading}
        size="large"
      >
        {loading ? "Creating Room..." : "Create Room"}
      </Button>
    </div>
  );
};