import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import styled, { css } from 'styled-components';
import { AnimatePresence, motion } from 'framer-motion';
import RuneIcon from './RuneIcon';
import { Tag, ListCheck, Maximize, Minimize, Moon, ArrowRight, Bell, Share2, Eye, EyeOff } from 'lucide-react';
import TagPicker from './TagPicker';
import { shareNotes, isSyncing } from '../utils/sync';
import MovePicker from './MovePicker';
import { marked } from 'marked';
import { toPlainTask } from '../utils/task';

marked.setOptions({ breaks: true, gfm: true });

const expandTransition = { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] };
const floatingBarTransition = { type: 'spring', damping: 25, stiffness: 300 };

function formatTimestamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (date.getTime() === today.getTime()) return `today ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.getTime() === yesterday.getTime()) return `yesterday ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`;
}

function TaskListItem({
  task,
  editing,
  fullscreen,
  fullscreenStartRect,
  dragging,
  onSave,
  onClose,
  onToggleComplete,
  onClick,
  onLongPressStart,
  onLongPressEnd,
  onContextMenu,
  onFullscreen,
  onExitFullscreen,
  availableTags,
  projects,
  onNavigateToTag,
  onAddGlobalTag,
  onDeleteGlobalTag,
  settings,
  onSnooze,
  onOpenSnoozePicker,
  itemRef,
}) {
  const [nameInput, setNameInput] = useState(task.name || '');
  const [notesInput, setNotesInput] = useState(task.notes || '');
  const [checklist, setChecklist] = useState(task.checklist || []);
  const [showChecklist, setShowChecklist] = useState((task.checklist || []).length > 0);
  const [newChecklistItem, setNewChecklistItem] = useState('');
  const [draggingChecklistId, setDraggingChecklistId] = useState(null);
  const [selectedTags, setSelectedTags] = useState(task.tags || []);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [notesMode, setNotesMode] = useState('edit');
  const [showToolbar, setShowToolbar] = useState(false);
  const [shareToast, setShareToast] = useState(false);
  const [lastSharedContent, setLastSharedContent] = useState(null);
  const inputRef = useRef(null);
  const fsInputRef = useRef(null);
  const notesRef = useRef(null);
  const containerRef = useRef(null);
  const contentRef = useRef(null);
  const autoSaveTimer = useRef(null);
  const checklistInputRefs = useRef({});
  const fsRectRef = useRef(null);

  const mergedRef = useCallback((el) => {
    containerRef.current = el;
    if (typeof itemRef === 'function') itemRef(el);
  }, [itemRef]);

  // Sync state when task data changes (but not while user is editing)
  useEffect(() => {
    if (editing || fullscreen) return;
    const plainTask = toPlainTask(task);
    setNameInput(plainTask.name);
    setNotesInput(plainTask.notes || '');
    setChecklist(plainTask.checklist || []);
    setShowChecklist((plainTask.checklist || []).length > 0);
    setNewChecklistItem('');
    setSelectedTags(plainTask.tags || []);
  }, [task, editing, fullscreen]);

  // Focus input when editing starts (only for new tasks)
  useEffect(() => {
    if (editing && !task.name) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [editing]);

  // Auto-resize notes textarea (up to 8 lines, then scroll)
  useEffect(() => {
    const el = notesRef.current;
    if (!el || fullscreen) return;
    el.style.height = '0';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22;
    const maxHeight = lineHeight * 8;
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [notesInput, editing, fullscreen]);

  // Build task object for saving
  const buildTaskForSave = () => {
    const updated = {
      id: task.id,
      name: nameInput.trim(),
      completed: task.completed || false,
    };
    if (task.order != null) updated.order = task.order;
    if (notesInput.trim()) {
      updated.notes = notesInput.trim();
    } else {
      updated.notes = null;
    }
    if (checklist.length > 0) {
      updated.checklist = checklist.map(item => ({
        id: item.id, text: item.text, completed: item.completed
      }));
    } else {
      updated.checklist = null;
    }
    if (selectedTags.length > 0) updated.tags = [...selectedTags];
    if (task.projectId != null) updated.projectId = task.projectId;
    if (task.created != null) updated.created = task.created;
    if (task.updated != null) updated.updated = task.updated;
    if (task.completedAt != null) updated.completedAt = task.completedAt;
    if (task.snoozeUntil != null) updated.snoozeUntil = task.snoozeUntil;
    if (task.reminder != null) updated.reminder = task.reminder;
    return updated;
  };

  // Auto-save with debounce
  useEffect(() => {
    if (!editing && !fullscreen) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      const saved = buildTaskForSave();
      const nameChanged = saved.name !== (task.name || '');
      const notesChanged = (saved.notes || '') !== (task.notes || '');
      const tagsChanged = JSON.stringify(saved.tags || []) !== JSON.stringify(task.tags || []);
      const checklistChanged = JSON.stringify(saved.checklist || []) !== JSON.stringify(task.checklist || []);
      if (nameChanged || notesChanged || tagsChanged || checklistChanged) {
        saved.updated = Date.now();
      }
      onSave?.(saved);
    }, 200);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [nameInput, notesInput, checklist, selectedTags, editing, fullscreen]);

  // Capture fullscreenStartRect so exit animation can use it even after prop is cleared
  useLayoutEffect(() => {
    if (fullscreen && fullscreenStartRect) {
      fsRectRef.current = fullscreenStartRect;
    }
  }, [fullscreen, fullscreenStartRect]);

  // Focus fullscreen input when entering fullscreen
  useEffect(() => {
    if (fullscreen) {
      requestAnimationFrame(() => fsInputRef.current?.focus());
    }
  }, [fullscreen]);

  // Reset toolbar/mode when leaving fullscreen
  useEffect(() => {
    if (!fullscreen) {
      setShowToolbar(false);
      setNotesMode('edit');
    }
  }, [fullscreen]);

  const handleShare = async () => {
    if (!notesInput) return;
    try {
      const { id, url } = await shareNotes(notesInput, task.shareId);
      if (!task.shareId) onSave({ ...task, shareId: id });
      setLastSharedContent(notesInput);
      if (navigator.share) {
        await navigator.share({ url });
      } else {
        await navigator.clipboard.writeText(url);
      }
      setShareToast(true);
      setTimeout(() => setShareToast(false), 2000);
    } catch (e) {
      if (e.name !== 'AbortError') console.error('Share failed:', e);
    }
  };

  const handleExitFullscreen = () => {
    setShowToolbar(false);
    onExitFullscreen?.();
  };

  const handleKeyDown = (e, isNotesField = false) => {
    if (e.key === 'Enter' && !isNotesField && !fullscreen) {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      onSave?.(buildTaskForSave());
      onClose?.();
    } else if (e.key === 'Escape') {
      if (fullscreen) {
        handleExitFullscreen();
      } else {
        onClose?.();
      }
    }
  };

  const handleToggleChecklistItem = (itemId) => {
    setChecklist(prev => prev.map(item =>
      item.id === itemId ? { ...item, completed: !item.completed } : item
    ));
  };

  const handleAddChecklistItem = (e) => {
    if (e.key === 'Enter' && newChecklistItem.trim()) {
      e.preventDefault();
      setChecklist(prev => [...prev, { id: Date.now(), text: newChecklistItem.trim(), completed: false }]);
      setNewChecklistItem('');
    }
  };

  const handleDeleteChecklistItem = (itemId) => {
    const index = checklist.findIndex(item => item.id === itemId);
    setChecklist(prev => prev.filter(item => item.id !== itemId));
    if (index > 0) {
      const prevItem = checklist[index - 1];
      setTimeout(() => { checklistInputRefs.current[prevItem.id]?.focus(); }, 0);
    }
  };

  const handleUpdateChecklistItem = (itemId, newText) => {
    setChecklist(prev => prev.map(item =>
      item.id === itemId ? { ...item, text: newText } : item
    ));
  };

  const handleChecklistItemKeyDown = (e, item) => {
    if (e.key === 'Backspace' && item.text === '') {
      e.preventDefault();
      handleDeleteChecklistItem(item.id);
    }
  };

  const handleChecklistDragStart = (e, itemId) => {
    e.preventDefault();
    setDraggingChecklistId(itemId);
  };

  const handleChecklistDragMove = (e) => {
    if (draggingChecklistId === null) return;
    e.preventDefault();
    const y = e.clientY ?? e.touches?.[0]?.clientY;
    if (y === undefined) return;
    for (const item of checklist) {
      const el = checklistInputRefs.current[item.id]?.parentElement;
      if (el && item.id !== draggingChecklistId) {
        const rect = el.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const dragIndex = checklist.findIndex(i => i.id === draggingChecklistId);
          const targetIndex = checklist.findIndex(i => i.id === item.id);
          if (dragIndex !== targetIndex) {
            const newChecklist = [...checklist];
            const [removed] = newChecklist.splice(dragIndex, 1);
            newChecklist.splice(targetIndex, 0, removed);
            setChecklist(newChecklist);
          }
          break;
        }
      }
    }
  };

  const handleChecklistDragEnd = () => { setDraggingChecklistId(null); };

  useEffect(() => {
    if (draggingChecklistId === null) return;
    const handleMove = (e) => handleChecklistDragMove(e);
    const handleEnd = () => handleChecklistDragEnd();
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [draggingChecklistId, checklist]);

  const toggleChecklist = () => { setShowChecklist(prev => !prev); };

  const isActive = editing || fullscreen;

  const rect = fullscreenStartRect || fsRectRef.current;

  return (
    <>
    <ItemContainer
      ref={mergedRef}
      $dragging={dragging}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
      style={fullscreen && fullscreenStartRect ? { height: fullscreenStartRect.height } : undefined}
    >
      <ItemContent
        ref={contentRef}
        animate={editing && !fullscreen ? {
          background: '#2a2a2a',
          borderRadius: '0.75rem',
          padding: '0.75rem 0.5rem 0.5rem',
        } : {
          background: 'rgba(42,42,42,0)',
          borderRadius: '0rem',
          padding: '0.5rem 0.5rem 0.5rem',
        }}
        transition={{ duration: 0.25, ease: [0.12, 0, 0, 1] }}
        onClick={(e) => {
          if (isActive) {
            e.stopPropagation();
          } else {
            onClick?.(e);
          }
        }}
        onMouseDown={!isActive ? onLongPressStart : undefined}
        onMouseUp={!isActive ? onLongPressEnd : undefined}
        onMouseLeave={!isActive ? onLongPressEnd : undefined}
        onTouchStart={!isActive ? onLongPressStart : undefined}
        onTouchEnd={!isActive ? onLongPressEnd : undefined}
        onContextMenu={onContextMenu}
      >
        <ContentArea>
          <MainRow>
            <Checkbox
              type="checkbox"
              checked={task.completed || false}
              onChange={onToggleComplete}
              onClick={(e) => e.stopPropagation()}
              disabled={isActive}
            />
            {editing && !fullscreen ? (
              <TaskInput
                ref={inputRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="New Task"
              />
            ) : (
              <TaskName $completed={task.completed} $isEmpty={!task.name}>
                {task.name || 'New Task'}
                {task.tags && task.tags.filter(t => availableTags.includes(t)).length > 0 && <TaskMetaIcon><Tag size="0.75rem" /></TaskMetaIcon>}
                {task.checklist && task.checklist.length > 0 && <TaskMetaIcon><ListCheck size="0.875rem" /></TaskMetaIcon>}
                {task.snoozeUntil && task.snoozeUntil > Date.now() && <TaskMetaIcon><Moon size="0.75rem" /></TaskMetaIcon>}
                {task.reminder && <TaskMetaIcon><Bell size="0.75rem" /></TaskMetaIcon>}
              </TaskName>
            )}
          </MainRow>

          <AnimatePresence initial={false}>
            {editing && !fullscreen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: [0.12, 0, 0, 1] }}
                style={{ overflow: 'hidden' }}
              >
                <ExpandableContent>
                  <NotesSection>
                    <NotesInput
                      ref={notesRef}
                      value={notesInput}
                      onChange={(e) => setNotesInput(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, true)}
                      placeholder="Notes"
                    />
                  </NotesSection>

                  {showChecklist && (
                    <ChecklistContainer>
                      {checklist.map(item => (
                        <ChecklistItem key={item.id} dragging={draggingChecklistId === item.id}>
                          <ChecklistCheckbox
                            type="checkbox"
                            checked={item.completed}
                            onChange={() => handleToggleChecklistItem(item.id)}
                          />
                          <ChecklistInput
                            ref={el => checklistInputRefs.current[item.id] = el}
                            value={item.text}
                            onChange={(e) => handleUpdateChecklistItem(item.id, e.target.value)}
                            onKeyDown={(e) => handleChecklistItemKeyDown(e, item)}
                            $completed={item.completed}
                          />
                          <DragHandle
                            onMouseDown={(e) => handleChecklistDragStart(e, item.id)}
                            onTouchStart={(e) => handleChecklistDragStart(e, item.id)}
                            onContextMenu={(e) => e.preventDefault()}
                          >
                            ⋮⋮
                          </DragHandle>
                        </ChecklistItem>
                      ))}
                      <ChecklistItem>
                        <ChecklistCheckbox type="checkbox" disabled style={{ opacity: 0.3 }} />
                        <ChecklistInput
                          value={newChecklistItem}
                          onChange={(e) => setNewChecklistItem(e.target.value)}
                          onKeyDown={handleAddChecklistItem}
                          placeholder="Add item..."
                        />
                      </ChecklistItem>
                    </ChecklistContainer>
                  )}

                  {selectedTags.filter(t => availableTags.includes(t)).length > 0 && (
                    <TagPills>
                      {selectedTags.filter(t => availableTags.includes(t)).map(tag => (
                        <TagPill key={tag} onClick={() => onNavigateToTag?.(tag)}>{tag}</TagPill>
                      ))}
                    </TagPills>
                  )}

                  <AnimatePresence>
                    {showTagPicker && (
                      <TagPicker
                        availableTags={availableTags}
                        selectedTags={selectedTags}
                        onToggleTag={(tag) => {
                          setSelectedTags(prev =>
                            prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
                          );
                        }}
                        onAddGlobalTag={onAddGlobalTag}
                        onDeleteGlobalTag={onDeleteGlobalTag}
                        onClose={() => setShowTagPicker(false)}
                      />
                    )}
                  </AnimatePresence>

                  <CardFooter>
                    <DateLabel>{task.projectId ? `○ ${(projects || []).find(p => p.id === task.projectId)?.name || ''}` : <><RuneIcon size="1em" style={{ marginRight: '0.25em' }} /> stꝋf</>}</DateLabel>
                    <CardIcons>
                      <IconButton onClick={() => setShowTagPicker(prev => !prev)}><Tag size="1rem" /></IconButton>
                      {checklist.length === 0 && (
                        <IconButton onClick={toggleChecklist} $active={showChecklist}><ListCheck size="1rem" /></IconButton>
                      )}
                      <IconButton onClick={(e) => { e.stopPropagation(); onFullscreen?.(); }}>
                        <Maximize size="1rem" />
                      </IconButton>
                    </CardIcons>
                  </CardFooter>
                </ExpandableContent>
              </motion.div>
            )}
          </AnimatePresence>
        </ContentArea>
      </ItemContent>

      <AnimatePresence>
        {editing && !fullscreen && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            transition={floatingBarTransition}
            style={{
              position: 'fixed',
              bottom: '1.5rem',
              left: 0,
              right: 0,
              display: 'flex',
              justifyContent: 'center',
              zIndex: 250,
              pointerEvents: 'none',
            }}
          >
            <FloatingBar>
              <FloatingButton onClick={(e) => { e.stopPropagation(); onOpenSnoozePicker?.(); }}>
                <Moon size="1rem" color="#F5C030" /> Later
              </FloatingButton>
              <FloatingButton onClick={(e) => { e.stopPropagation(); setShowMovePicker(true); }}>
                <ArrowRight size="1rem" /> Move
              </FloatingButton>
            </FloatingBar>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showMovePicker && (
          <MovePicker
            projects={projects}
            currentProjectId={task.projectId}
            onMove={(projectId) => {
              const updated = buildTaskForSave();
              updated.projectId = projectId || null;
              onSave?.(updated);
            }}
            onClose={() => setShowMovePicker(false)}
          />
        )}
      </AnimatePresence>
    </ItemContainer>

    {createPortal(
      <AnimatePresence>
        {fullscreen && (
          <motion.div
            style={{
              position: 'fixed',
              zIndex: 200,
              overflow: 'hidden',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              padding: '0.75rem 0.5rem 0.5rem',
            }}
            initial={{
              top: rect?.top ?? 0,
              left: rect?.left ?? 0,
              width: rect?.width ?? window.innerWidth,
              height: rect?.height ?? window.innerHeight,
              borderRadius: '0.75rem',
              background: '#2a2a2a',
            }}
            animate={{
              top: 0,
              left: 0,
              width: window.innerWidth,
              height: window.innerHeight,
              borderRadius: 0,
              background: '#242424',
            }}
            exit={{
              top: rect?.top ?? 0,
              left: rect?.left ?? 0,
              width: rect?.width ?? window.innerWidth,
              height: rect?.height ?? window.innerHeight,
              borderRadius: '0.75rem',
              background: '#2a2a2a',
            }}
            transition={{ duration: 0.35, ease: [0.12, 0, 0, 1] }}
            onAnimationComplete={() => { if (fullscreen) setShowToolbar(true); }}
            onClick={(e) => e.stopPropagation()}
          >
            <MainRow style={{ flexShrink: 0 }}>
              <Checkbox
                type="checkbox"
                checked={task.completed || false}
                onChange={onToggleComplete}
                onClick={(e) => e.stopPropagation()}
                disabled
              />
              <TaskInput
                ref={fsInputRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="New Task"
              />
            </MainRow>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.12, 0, 0, 1] }}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}
            >
              <ExpandableContent $fullscreen>
                <NotesSection $fullscreen>
                  {notesMode === 'preview' ? (
                    <MarkdownPreview dangerouslySetInnerHTML={{ __html: marked(notesInput || '') }} />
                  ) : (
                    <NotesInput
                      $fullscreen
                      ref={notesRef}
                      value={notesInput}
                      onChange={(e) => setNotesInput(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, true)}
                      placeholder="Notes"
                    />
                  )}
                </NotesSection>

                {showChecklist && (
                  <ChecklistContainer>
                    {checklist.map(item => (
                      <ChecklistItem key={item.id} dragging={draggingChecklistId === item.id}>
                        <ChecklistCheckbox
                          type="checkbox"
                          checked={item.completed}
                          onChange={() => handleToggleChecklistItem(item.id)}
                        />
                        <ChecklistInput
                          value={item.text}
                          onChange={(e) => handleUpdateChecklistItem(item.id, e.target.value)}
                          onKeyDown={(e) => handleChecklistItemKeyDown(e, item)}
                          $completed={item.completed}
                        />
                        <DragHandle
                          onMouseDown={(e) => handleChecklistDragStart(e, item.id)}
                          onTouchStart={(e) => handleChecklistDragStart(e, item.id)}
                          onContextMenu={(e) => e.preventDefault()}
                        >
                          ⋮⋮
                        </DragHandle>
                      </ChecklistItem>
                    ))}
                    <ChecklistItem>
                      <ChecklistCheckbox type="checkbox" disabled style={{ opacity: 0.3 }} />
                      <ChecklistInput
                        value={newChecklistItem}
                        onChange={(e) => setNewChecklistItem(e.target.value)}
                        onKeyDown={handleAddChecklistItem}
                        placeholder="Add item..."
                      />
                    </ChecklistItem>
                  </ChecklistContainer>
                )}

                {selectedTags.filter(t => availableTags.includes(t)).length > 0 && (
                  <TagPills>
                    {selectedTags.filter(t => availableTags.includes(t)).map(tag => (
                      <TagPill key={tag} onClick={() => onNavigateToTag?.(tag)}>{tag}</TagPill>
                    ))}
                  </TagPills>
                )}

                <AnimatePresence>
                  {showTagPicker && (
                    <TagPicker
                      availableTags={availableTags}
                      selectedTags={selectedTags}
                      onToggleTag={(tag) => {
                        setSelectedTags(prev =>
                          prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
                        );
                      }}
                      onAddGlobalTag={onAddGlobalTag}
                      onDeleteGlobalTag={onDeleteGlobalTag}
                      onClose={() => setShowTagPicker(false)}
                    />
                  )}
                </AnimatePresence>

                <CardFooter>
                  <DateLabel>{task.projectId ? `○ ${(projects || []).find(p => p.id === task.projectId)?.name || ''}` : <><RuneIcon size="1em" style={{ marginRight: '0.25em' }} /> stꝋf</>}</DateLabel>
                  <CardIcons>
                    {isSyncing() && notesInput && (
                      <IconButton onClick={handleShare} style={task.shareId && notesInput !== (lastSharedContent ?? notesInput) ? { color: '#007AFF' } : undefined}>
                        <Share2 size="1rem" />
                      </IconButton>
                    )}
                    <IconButton onClick={() => setNotesMode(prev => prev === 'preview' ? 'edit' : 'preview')} $active={notesMode === 'preview'}>
                      {notesMode === 'preview' ? <EyeOff size="1rem" /> : <Eye size="1rem" />}
                    </IconButton>
                    <IconButton onClick={() => setShowTagPicker(prev => !prev)}><Tag size="1rem" /></IconButton>
                    {checklist.length === 0 && (
                      <IconButton onClick={toggleChecklist} $active={showChecklist}><ListCheck size="1rem" /></IconButton>
                    )}
                    <IconButton onClick={(e) => { e.stopPropagation(); handleExitFullscreen(); }}>
                      <Minimize size="1rem" />
                    </IconButton>
                  </CardIcons>
                </CardFooter>
                {shareToast && <ShareToast>Link copied to clipboard</ShareToast>}
              </ExpandableContent>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body
    )}

    {createPortal(
      <AnimatePresence>
        {showToolbar && fullscreen && task.updated && (
          <motion.div
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -40, opacity: 0 }}
            transition={floatingBarTransition}
            style={{
              position: 'fixed',
              top: '1.1rem',
              right: '1rem',
              zIndex: 250,
              pointerEvents: 'none',
            }}
          >
            <Timestamps $show style={{ position: 'static', opacity: 1 }}>
              updated {formatTimestamp(task.updated)}
            </Timestamps>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body
    )}

    </>
  );
}

export default React.memo(TaskListItem, (prev, next) => {
  if (prev.task !== next.task) return false;
  if (prev.editing !== next.editing) return false;
  if (prev.fullscreen !== next.fullscreen) return false;
  if (prev.dragging !== next.dragging) return false;
  if (prev.fullscreenStartRect !== next.fullscreenStartRect) return false;
  if (prev.availableTags !== next.availableTags) return false;
  if (prev.settings !== next.settings) return false;
  return true;
});

const ItemContainer = styled(motion.li)`
  opacity: ${props => props.$dragging ? 0.5 : 1};
  margin-bottom: 0.25rem;
`;

const ItemContent = styled(motion.div)`
  user-select: none;
`;

const ContentArea = styled.div`
  position: relative;
`;

const MainRow = styled.div`
  display: flex;
  align-items: center;
  flex-shrink: 0;
  min-height: 1.5rem;
`;

const Timestamps = styled.div`
  position: absolute;
  top: 0.375rem;
  right: 0.25rem;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0;
  color: #666;
  font-size: 0.5625rem;
  opacity: ${props => props.$show ? 1 : 0};
  transition: opacity 0.25s ease;
`;

const NotesToolbar = styled.div`
  overflow: hidden;
  max-height: ${props => props.$show ? '2.75rem' : '0'};
  opacity: ${props => props.$show ? 1 : 0};
  transition: max-height 0.25s ease, opacity 0.2s ease;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding: ${props => props.$show ? '0.75rem 0 0' : '0'};
`;

const ToggleGroup = styled.div`
  display: flex;
  background: #333;
  border-radius: 0.375rem;
  padding: 0.125rem;
`;

const ToggleButton = styled.button`
  background: ${props => props.$active ? '#555' : 'transparent'};
  border: none;
  color: ${props => props.$active ? '#fff' : '#888'};
  padding: 0.25rem 0.875rem;
  width: 4.625rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease;

  &:hover {
    color: #ccc;
  }
`;

const ExpandableContent = styled.div`
  margin-top: 0.75rem;

  ${props => props.$fullscreen && css`
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding-bottom: calc(env(safe-area-inset-bottom, 0) + 0.75rem);
  `}
`;

const NotesSection = styled.div`
  margin-left: 1rem;
  margin-right: 1rem;
  margin-bottom: 1rem;

  ${props => props.$fullscreen && css`
    margin-bottom: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  `}
`;

const NotesInput = styled.textarea`
  color: #888;
  font-size: 0.875rem;
  line-height: 1.6;
  background: transparent;
  border: none;
  outline: none;
  width: 100%;
  resize: none;
  font-family: inherit;
  box-sizing: border-box;
  height: auto;
  min-height: 0;

  ${props => props.$fullscreen && css`
    flex: 1;
    overflow-y: auto;
  `}

  &::placeholder {
    color: #666;
  }
`;

const MarkdownPreview = styled.div`
  flex: 1;
  overflow-y: auto;
  color: #ccc;
  font-size: 0.875rem;
  line-height: 1.6;

  h1, h2, h3, h4, h5, h6 {
    color: white;
    margin-top: 1em;
    margin-bottom: 0.5em;
  }

  h1 { font-size: 1.6em; }
  h2 { font-size: 1.4em; }
  h3 { font-size: 1.2em; }

  p { margin-bottom: 0.8em; }

  ul, ol {
    margin-bottom: 0.8em;
    padding-left: 1.5em;
  }

  li { margin-bottom: 0.3em; }

  code {
    background: #333;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-family: monospace;
  }

  pre {
    background: #333;
    padding: 0.75rem;
    border-radius: 0.5rem;
    overflow-x: auto;
    margin-bottom: 0.8em;

    code {
      background: none;
      padding: 0;
    }
  }

  blockquote {
    border-left: 3px solid #555;
    padding-left: 0.75rem;
    color: #999;
    margin-bottom: 0.8em;
  }

  a { color: #00D8FF; }

  hr {
    border: none;
    border-top: 1px solid #444;
    margin: 1em 0;
  }
`;

const ChecklistContainer = styled.div`
  margin-left: 1rem;
  margin-right: 1rem;
  margin-bottom: 1rem;
  flex-shrink: 0;
`;

const ChecklistItem = styled.div`
  display: flex;
  align-items: center;
  margin-bottom: 0.5rem;
  opacity: ${props => props.dragging ? 0.5 : 1};
`;

const ChecklistCheckbox = styled.input`
  margin-right: 0.5rem;
`;

const ChecklistInput = styled.input`
  flex: 1;
  background: transparent;
  border: none;
  color: ${props => props.$completed ? '#666' : '#ccc'};
  text-decoration: ${props => props.$completed ? 'line-through' : 'none'};
  font-size: 0.875rem;
  outline: none;

  &::placeholder {
    color: #666;
  }
`;

const DragHandle = styled.span`
  color: #666;
  font-size: 0.875rem;
  cursor: grab;
  padding: 0 0.25rem;
  opacity: 0.6;
  user-select: none;

  &:hover {
    opacity: 1;
  }

  &:active {
    cursor: grabbing;
  }
`;

const CardFooter = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
`;

const DateLabel = styled.div`
  color: #888;
  font-size: 0.875rem;
`;

const CardIcons = styled.div`
  display: flex;
`;

const ShareToast = styled.div`
  position: absolute;
  bottom: 3.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: #333;
  color: #fff;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  white-space: nowrap;
`;

const IconButton = styled.button`
  background: none;
  border: none;
  outline: none;
  color: inherit;
  padding: 0.8em 0.8em 0.2em;
  font-size: 1rem;
  cursor: pointer;
  opacity: ${props => props.$active ? 1 : 0.6};
`;

const Checkbox = styled.input`
  margin-right: 0.625rem;
  width: 0.9rem;
  height: 0.9rem;
  flex-shrink: 0;
  appearance: none;
  -webkit-appearance: none;
  border: 1.5px solid #666;
  border-radius: 0.2rem;
  background: transparent;
  cursor: pointer;
  position: relative;

  &:checked {
    background: transparent;
    border-color: #aaa;
  }

  &:checked::after {
    content: '';
    position: absolute;
    left: 0.1rem;
    top: -0.2rem;
    width: 0.45rem;
    height: 0.7rem;
    border: 1.5px solid #aaa;
    border-top: none;
    border-left: none;
    transform: rotate(45deg);
  }
`;

const TaskInput = styled.input`
  flex: 1;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  color: white;
  font-size: 1rem;
  font-family: inherit;
  outline: none;
  user-select: text;

  &::placeholder {
    color: #888;
  }
`;

const TaskName = styled.span`
  text-decoration: ${props => (props.$completed ? 'line-through' : 'none')};
  opacity: ${props => (props.$isEmpty ? 0.4 : 1)};
`;

const TaskMetaIcon = styled.span`
  color: #666;
  font-size: 0.75rem;
  margin-left: 0.375rem;
`;

const TagPills = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin: 0 1rem 0.75rem;
  flex-shrink: 0;
`;

const TagPill = styled.button`
  background: #2d5a3d;
  color: #7ddf9e;
  border: none;
  border-radius: 0.75rem;
  padding: 0.1875rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;

  &:hover {
    background: #366b48;
  }
`;

const FloatingBar = styled.div`
  pointer-events: auto;
  background: #3a3a3c;
  border-radius: 1.25rem;
  padding: 0.5rem 0.75rem;
  display: flex;
  gap: 0.5rem;
  box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.4);
`;

const FloatingButton = styled.button`
  background: none;
  border: none;
  color: #ccc;
  font-size: 0.9375rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;

  &:hover {
    color: white;
  }
`;
