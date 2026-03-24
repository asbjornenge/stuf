/**
 * Convert a task (potentially an Automerge proxy) to a plain JS object.
 * Automerge proxies cannot be spread or reused directly.
 */
export function toPlainTask(task) {
  const plain = {
    id: task.id,
    name: task.name || '',
    completed: task.completed || false,
  };

  if (task.order != null) {
    plain.order = task.order;
  }

  if (task.notes) {
    plain.notes = task.notes;
  }

  if (task.checklist && task.checklist.length > 0) {
    plain.checklist = task.checklist.map(item => ({
      id: item.id,
      text: item.text,
      completed: item.completed
    }));
  }

  if (task.tags && task.tags.length > 0) {
    plain.tags = task.tags.map(t => typeof t === 'string' ? t : String(t));
  }

  if (task.projectId != null) {
    plain.projectId = task.projectId;
  }

  if (task.created != null) {
    plain.created = task.created;
  }

  if (task.updated != null) {
    plain.updated = task.updated;
  }

  if (task.completedAt != null) {
    plain.completedAt = task.completedAt;
  }

  if (task.snoozeUntil != null) {
    plain.snoozeUntil = task.snoozeUntil;
  }

  if (task.reminder != null) {
    plain.reminder = task.reminder;
  }

  if (task.shareId != null) {
    plain.shareId = task.shareId;
  }

  return plain;
}
