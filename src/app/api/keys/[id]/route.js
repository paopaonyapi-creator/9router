import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, getApiKeys, updateApiKey } from "@/lib/localDb";

// Deleting or pausing the last active key locks out /v1 entirely — refuse with 400.
async function isLastActiveKey(id) {
  const keys = await getApiKeys();
  const active = keys.filter((k) => k.isActive !== false);
  return active.length === 1 && active[0]?.id === id;
}

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    if (isActive === false && existing.isActive !== false && (await isLastActiveKey(id))) {
      return NextResponse.json({ error: "Cannot pause the last active API key — /v1 would reject every request" }, { status: 400 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    if (existing.isActive !== false && (await isLastActiveKey(id))) {
      return NextResponse.json({ error: "Cannot delete the last active API key — create a replacement first" }, { status: 400 });
    }

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
