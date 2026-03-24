import React, { useState, useRef } from 'react';
import styled from 'styled-components';
import { motion } from 'framer-motion';
import RuneIcon from './RuneIcon';
import { Tag, CircleX, Search } from 'lucide-react';

export default function SearchModal({
  availableTags,
  recentTags,
  activeTagFilter,
  activeView,
  activeProjectId,
  projects,
  tasks,
  onNavigateToTag,
  onNavigateToView,
  onNavigateToProject,
  onOpenTask,
  onClose,
}) {
  const [query, setQuery] = useState('');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const inputRef = useRef(null);

  const hasQuery = query.trim().length > 0;
  const lowerQuery = query.toLowerCase();

  // Lists: views + projects + tags
  const allLists = [
    { type: 'view', label: 'stꝋf', icon: <RuneIcon />, id: 'stof' },
    { type: 'view', label: 'Log', icon: '📓', id: 'log' },
    ...(projects || []).map(p => ({
      type: 'project', label: p.name, icon: '○', id: p.id,
    })),
    ...availableTags.map(tag => ({
      type: 'tag', label: tag, icon: <Tag size="1.125rem" />, id: tag,
    })),
  ];

  // Default view: stꝋf + 3 recent tags
  const defaultLists = [
    allLists[0],
    ...recentTags
      .filter(t => availableTags.includes(t))
      .slice(0, 3)
      .map(tag => ({ type: 'tag', label: tag, icon: <Tag size="1.125rem" />, id: tag })),
  ];

  // Filtered lists when searching
  const filteredLists = hasQuery
    ? allLists.filter(item => item.label.toLowerCase().includes(lowerQuery))
    : defaultLists;

  // Task search
  const activeTasks = hasQuery
    ? tasks.filter(t => !t.completed && t.name && t.name.toLowerCase().includes(lowerQuery))
    : [];

  const completedTasks = hasQuery && includeCompleted
    ? tasks.filter(t => t.completed && t.name && t.name.toLowerCase().includes(lowerQuery))
    : [];

  const allMatchedTasks = [...activeTasks, ...completedTasks];

  const noResults = hasQuery && filteredLists.length === 0 && allMatchedTasks.length === 0;
  const showContinueSearch = hasQuery && !includeCompleted && activeTasks.length === 0 && filteredLists.length === 0;

  const handleSelectList = (item) => {
    if (item.type === 'view') {
      onNavigateToView(item.id);
    } else if (item.type === 'project') {
      onNavigateToProject(item.id);
    } else {
      onNavigateToTag(item.id);
    }
    onClose();
  };

  const handleSelectTask = (task) => {
    onOpenTask(task.id);
    onClose();
  };

  const isActive = (item) => {
    if (item.type === 'view' && !activeTagFilter && !activeProjectId && activeView === item.id) return true;
    if (item.type === 'project' && activeProjectId === item.id) return true;
    if (item.type === 'tag' && activeTagFilter === item.id) return true;
    return false;
  };

  return (
    <Overlay onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <Modal onClick={(e) => e.stopPropagation()} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.15 }}>
        <SearchRow>
          <SearchIcon><Search size="1rem" /></SearchIcon>
          <SearchInput
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIncludeCompleted(false); }}
            placeholder="Quick Find"
            autoFocus
          />
          <CloseButton onClick={onClose}><CircleX size="1.5rem" /></CloseButton>
        </SearchRow>
        <List>
          {filteredLists.length > 0 && (
            <>
              <SectionLabel>{hasQuery ? 'Lists' : 'Recent'}</SectionLabel>
              {filteredLists.map((item) => (
                <Item key={`${item.type}-${item.id}`} onClick={() => handleSelectList(item)}>
                  <ItemIcon>{item.icon}</ItemIcon>
                  <ItemLabel>{item.label}</ItemLabel>
                </Item>
              ))}
            </>
          )}
          {allMatchedTasks.length > 0 && (
            <>
              <SectionLabel>Tasks</SectionLabel>
              {allMatchedTasks.map((task) => (
                <Item key={`task-${task.id}`} onClick={() => handleSelectTask(task)}>
                  <ItemIcon style={{ opacity: task.completed ? 0.4 : 1 }}>☐</ItemIcon>
                  <ItemLabel style={{
                    textDecoration: task.completed ? 'line-through' : 'none',
                    opacity: task.completed ? 0.5 : 1,
                  }}>
                    {task.name}
                  </ItemLabel>
                </Item>
              ))}
            </>
          )}
          {showContinueSearch && (
            <ContinueButton onClick={() => setIncludeCompleted(true)}>
              Continue search in completed tasks...
            </ContinueButton>
          )}
          {noResults && includeCompleted && (
            <NoResults>No results found</NoResults>
          )}
        </List>
        <HelpText>Quickly switch lists, find to-dos, search for tags...</HelpText>
      </Modal>
    </Overlay>
  );
}

const Overlay = styled(motion.div)`
  position: fixed;
  inset: 0;
  z-index: 300;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  padding-top: 5rem;
`;

const Modal = styled(motion.div)`
  background: #3a3a3c;
  border-radius: 0.75rem;
  width: 18.75rem;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-self: flex-start;
`;

const SearchRow = styled.div`
  display: flex;
  align-items: center;
  padding: 0.75rem 1rem;
  gap: 0.5rem;
`;

const SearchIcon = styled.span`
  font-size: 1.25rem;
  color: #888;
`;

const SearchInput = styled.input`
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  color: white;
  font-size: 1rem;
  outline: none;

  &::placeholder {
    color: #888;
  }
`;

const CloseButton = styled.button`
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  &:hover {
    color: white;
  }
`;

const List = styled.div`
  overflow-y: auto;
  padding: 0 1rem;
  border-top: 1px solid #555;
`;

const SectionLabel = styled.div`
  color: #888;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03125rem;
  padding: 0.75rem 0 0.375rem;
`;

const Item = styled.div`
  display: flex;
  align-items: center;
  padding: 0.75rem 0;
  cursor: pointer;

  &:hover {
    opacity: 0.8;
  }
`;

const ItemIcon = styled.span`
  font-size: 1.125rem;
  margin-right: 0.75rem;
`;

const ItemLabel = styled.span`
  flex: 1;
  color: white;
  font-size: 1rem;
  font-weight: 500;
`;

const CheckMark = styled.span`
  color: #4ca6ff;
  font-size: 1.125rem;
`;

const ContinueButton = styled.button`
  background: none;
  border: none;
  color: #4ca6ff;
  font-size: 0.875rem;
  padding: 0.875rem 0;
  cursor: pointer;
  text-align: left;
  width: 100%;

  &:hover {
    opacity: 0.8;
  }
`;

const NoResults = styled.div`
  color: #666;
  font-size: 0.875rem;
  padding: 0.875rem 0;
  text-align: center;
`;

const HelpText = styled.div`
  color: #666;
  font-size: 0.8125rem;
  text-align: center;
  padding: 1rem;
  border-top: 1px solid #555;
`;
