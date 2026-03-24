import React, { useRef } from 'react';
import TaskList from './components/TaskList';
import CheckoutReturn from './components/CheckoutReturn';

function App() {
  const taskListRef = useRef();

  return (
    <>
      <CheckoutReturn onComplete={(result) => {
        if (!result.error) {
          if (result.type === 'purchase') {
            taskListRef.current?.onCheckoutComplete();
          } else if (result.type === 'renew') {
            taskListRef.current?.onRenewComplete();
          }
        }
      }} />
      <TaskList ref={taskListRef} />
    </>
  );
}

export default App;
