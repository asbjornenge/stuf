import React, { useState } from 'react';
import styled from 'styled-components';
import { motion } from 'framer-motion';
import { Tag, CircleX, Search, Plus, Check, Trash2 } from 'lucide-react';
import { colors } from '../theme';

export default function TagPicker({
  availableTags,
  selectedTags,
  onToggleTag,
  onAddGlobalTag,
  onDeleteGlobalTag,
  onClose,
}) {
  const [newTagInput, setNewTagInput] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [manageMode, setManageMode] = useState(false);

  const handleClose = () => {
    setManageMode(false);
    setNewTagInput('');
    setSearchInput('');
    onClose();
  };

  const filteredTags = (availableTags || []).filter(tag =>
    tag.toLowerCase().includes(searchInput.toLowerCase())
  );

  return (
    <Overlay onClick={handleClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <Modal onClick={(e) => e.stopPropagation()} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.15 }}>
        <SearchRow>
          <SearchIcon><Tag size="1rem" /></SearchIcon>
          <SearchInput
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Tag find"
          />
          <CloseButton onClick={handleClose}><CircleX size="1.5rem" /></CloseButton>
        </SearchRow>
        <List>
          {filteredTags.length > 0 && (
            <>
              <SectionLabel>Select</SectionLabel>
              {filteredTags.map(tag => {
                const isSelected = selectedTags.includes(tag);
                return (
                  <Item
                    key={tag}
                    onClick={() => { if (!manageMode) onToggleTag(tag); }}
                  >
                    <ItemIcon selected={isSelected}><Tag size="1.125rem" /></ItemIcon>
                    <ItemLabel selected={isSelected}>{tag}</ItemLabel>
                    {manageMode ? (
                      <DeleteBtn onClick={(e) => {
                        e.stopPropagation();
                        onDeleteGlobalTag?.(tag);
                      }}><Trash2 size="1rem" /></DeleteBtn>
                    ) : (
                      isSelected && <CheckMark><Check size="1rem" /></CheckMark>
                    )}
                  </Item>
                );
              })}
            </>
          )}
          <SectionLabel>New tag</SectionLabel>
          <NewTagRow>
            <NewTagIcon><Plus size="1rem" /></NewTagIcon>
            <NewTagInput
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTagInput.trim()) {
                  onAddGlobalTag?.(newTagInput.trim());
                  setNewTagInput('');
                }
              }}
              placeholder="Tag name..."
            />
            {newTagInput.trim() && (
              <AddButton onClick={() => {
                onAddGlobalTag?.(newTagInput.trim());
                setNewTagInput('');
              }}>
                Add
              </AddButton>
            )}
          </NewTagRow>
        </List>
        <Footer>
          <ManageButton onClick={() => setManageMode(prev => !prev)}>
            {manageMode ? 'Done' : 'Manage Tags'}
          </ManageButton>
        </Footer>
      </Modal>
    </Overlay>
  );
}

const Overlay = styled(motion.div)`
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
`;

const Modal = styled(motion.div)`
  background: #3a3a3c;
  border-radius: 0.75rem;
  width: 18.75rem;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const SearchRow = styled.div`
  display: flex;
  align-items: center;
  padding: 0.75rem 1rem;
  gap: 0.5rem;
`;

const SearchIcon = styled.span`
  color: #888;
  display: flex;
  align-items: center;
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
  margin-right: 0.75rem;
  color: ${props => props.selected ? '#aaa' : '#666'};
  display: flex;
  align-items: center;
`;

const ItemLabel = styled.span`
  flex: 1;
  color: ${props => props.selected ? 'white' : '#ccc'};
  font-size: 1rem;
`;

const CheckMark = styled.span`
  color: ${colors.coral};
  display: flex;
  align-items: center;
`;

const DeleteBtn = styled.button`
  background: none;
  border: none;
  color: #ff453a;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
`;

const NewTagRow = styled.div`
  display: flex;
  align-items: center;
  padding: 0.5rem 0 0.75rem;
  gap: 0.5rem;
`;

const NewTagIcon = styled.span`
  color: #888;
  display: flex;
  align-items: center;
`;

const NewTagInput = styled.input`
  flex: 1;
  background: transparent;
  border: none;
  color: white;
  font-size: 1rem;
  outline: none;

  &::placeholder {
    color: #666;
  }
`;

const AddButton = styled.button`
  background: none;
  border: none;
  color: #4ca6ff;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0;

  &:hover {
    opacity: 0.8;
  }
`;

const Footer = styled.div`
  padding: 0.5rem 1rem;
  border-top: 1px solid #555;
`;

const ManageButton = styled.button`
  background: none;
  border: none;
  color: #888;
  font-size: 0.875rem;
  cursor: pointer;
  padding: 0.5rem 0;
  width: 100%;
  text-align: center;

  &:hover {
    color: white;
  }
`;
