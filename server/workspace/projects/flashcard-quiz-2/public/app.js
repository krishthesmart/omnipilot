// Front‑end script for the flashcard quiz app.
// Communicates with the Python API using fetch and updates the DOM.
//
// Expected HTML elements (by ID):
//   #question      – container for the current question text
//   #answerInput   – <input> where the user types their answer
//   #submitBtn     – button that triggers answer submission
//   #result        – container for feedback (correct / incorrect)
//   #addForm       – <form> for adding a new flashcard
//   #newQuestion   – input field inside #addForm for the question
//   #newAnswer     – input field inside #addForm for the answer
//
// The API endpoints:
//   GET  /card   → { "question": "..." }
//   POST /check  → { "question": "...", "answer": "..." } → { "correct": true|false }
//   POST /add    → { "question": "...", "answer": "..." } → {} (empty JSON on success)

'use strict';

(() => {
  // Keep the currently displayed question so we can send it back for checking.
  let currentQuestion = '';

  /** Fetch a random card from the API and display its question. */
  async function loadCard() {
    try {
      const response = await fetch('/card', { method: 'GET' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.question) throw new Error('Invalid response: missing question');
      currentQuestion = data.question;
      const questionEl = document.getElementById('question');
      if (questionEl) questionEl.textContent = currentQuestion;
      // Clear previous answer/result.
      const answerInput = document.getElementById('answerInput');
      if (answerInput) answerInput.value = '';
      const resultEl = document.getElementById('result');
      if (resultEl) {
        resultEl.textContent = '';
        resultEl.classList.remove('result-correct', 'result-wrong');
      }
    } catch (err) {
      console.error('Failed to load card:', err);
      displayResult('Error loading question.', false);
    }
  }

  /** Submit the user's answer to the API and display whether it was correct. */
  async function submitAnswer() {
    const answerInput = document.getElementById('answerInput');
    if (!answerInput) {
      console.error('Missing #answerInput element.');
      return;
    }
    const userAnswer = answerInput.value.trim();
    if (userAnswer === '') {
      displayResult('Please enter an answer.', false);
      return;
    }

    try {
      const payload = { question: currentQuestion, answer: userAnswer };
      const response = await fetch('/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (typeof result.correct !== 'boolean') {
        throw new Error('Invalid response: missing "correct" boolean');
      }
      displayResult(result.correct ? 'Correct!' : 'Incorrect.', result.correct);
    } catch (err) {
      console.error('Failed to check answer:', err);
      displayResult('Error checking answer.', false);
    }
  }

  /** Add a new flashcard via the API, then load a fresh card. */
  async function addCard(event) {
    // Prevent the form from submitting the traditional way.
    if (event && typeof event.preventDefault === 'function') event.preventDefault();

    const qInput = document.getElementById('newQuestion');
    const aInput = document.getElementById('newAnswer');
    if (!qInput || !aInput) {
      console.error('Missing #newQuestion or #newAnswer elements.');
      return;
    }
    const newQuestion = qInput.value.trim();
    const newAnswer = aInput.value.trim();

    if (newQuestion === '' || newAnswer === '') {
      displayResult('Both question and answer are required to add a card.', false);
      return;
    }

    try {
      const payload = { question: newQuestion, answer: newAnswer };
      const response = await fetch('/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Assume success if we get a 2xx response.
      qInput.value = '';
      aInput.value = '';
      displayResult('Card added successfully!', true);
      // Load a new card to continue the quiz.
      await loadCard();
    } catch (err) {
      console.error('Failed to add card:', err);
      displayResult('Error adding card.', false);
    }
  }

  /** Helper to show feedback in the #result element. */
  function displayResult(message, isCorrect) {
    const resultEl = document.getElementById('result');
    if (!resultEl) {
      console.error('Missing #result element.');
      return;
    }
    resultEl.textContent = message;
    resultEl.classList.toggle('result-correct', isCorrect);
    resultEl.classList.toggle('result-wrong', !isCorrect);
  }

  // Attach event listeners once the DOM is ready.
  document.addEventListener('DOMContentLoaded', () => {
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) submitBtn.addEventListener('click', submitAnswer);

    const addForm = document.getElementById('addForm');
    if (addForm) addForm.addEventListener('submit', addCard);

    // Initial load of a card.
    loadCard();
  });

  // Export functions for potential testing (optional).
  window.flashcardApp = { loadCard, submitAnswer, addCard };
})();
