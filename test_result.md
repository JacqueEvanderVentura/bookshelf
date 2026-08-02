#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================
user_problem_statement: |
  A cozy mobile-first PWA reading app for Daniela (learning English) with tap-to-define words via Fireworks AI,
  TTS pronunciation, bookmarks, and directory picker to import her own .epub files from Downloads/books.

frontend:
  - task: "BookCard nested button hydration bug"
    implemented: true
    working: true
    file: "app/page.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: false
        agent: "user"
        comment: "User reported: <button> cannot be a descendant of <button>. BookCard used motion.button with a nested remove-button inside."
      - working: true
        agent: "main"
        comment: "Fixed by changing outer motion.button to motion.div with role='button', tabIndex=0, and onKeyDown handler for Enter/Space. Nested remove button is now valid."
      - working: true
        agent: "testing"
        comment: "VERIFIED: No console errors about button descendants. Tested on mobile viewport (430x900). Zero hydration errors, zero button nesting errors on page load and throughout all interactions. BookCard now uses motion.div with proper accessibility attributes."

  - task: "Hidden file inputs hydration mismatch"
    implemented: true
    working: true
    file: "app/page.js"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: false
        agent: "user"
        comment: "User reported hydration mismatch on file inputs because a browser extension adds data-cnp-create-listener attribute to inputs after SSR."
      - working: true
        agent: "main"
        comment: "Added suppressHydrationWarning to both hidden file inputs to safely ignore extension-added attributes."
      - working: true
        agent: "testing"
        comment: "VERIFIED: No hydration mismatch errors. Both hidden file inputs (lines 386-404 in app/page.js) have suppressHydrationWarning attribute. Zero hydration warnings in console throughout testing."

  - task: "EPUB directory picker + file import"
    implemented: true
    working: true
    file: "app/page.js, lib/epub-parser.js, lib/library-store.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Added + button on shelf header opening AddBooksSheet. Chrome/Edge users get showDirectoryPicker for recursive folder scan; iOS/Safari users get multi-file input. EPUB files parsed via JSZip -> OPF -> spine sections -> paragraphs. Books persisted in IndexedDB. Verified end-to-end with synthetic 2-chapter EPUB."
      - working: true
        agent: "testing"
        comment: "VERIFIED: End-to-end EPUB import working perfectly. Clicked '+' button, Add Books sheet opened with 'Choose a folder' and 'Pick individual files' options. Privacy text renders correctly with em-dash (no literal \\u2014). Uploaded /tmp/test-book.epub via file input, book parsed and saved successfully. New 'My Books' section appeared with 'The Test Adventure' by Emergent AI. Toast message 'Added 1 book to your shelf' displayed correctly."

  - task: "Chapter navigation in reader"
    implemented: true
    working: true
    file: "app/page.js"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Reader now supports multi-chapter EPUBs: header shows 'Chapter X of Y', footer has Previous/Next buttons. Scroll resets and progress persists per chapter."
      - working: true
        agent: "testing"
        comment: "VERIFIED: Chapter navigation working perfectly. Opened 'The Test Adventure' (2-chapter EPUB). Chapter 1 shows 'Chapter 1 of 2', body contains 'Daniela was walking through the meadow...', Previous button disabled, Next button enabled. Clicked Next, header updated to 'Chapter 2 of 2', body shows 'The rabbit turned and looked at her...', Previous now enabled, Next now disabled. Button states correct at both chapter boundaries."

  - task: "Live scroll progress bar"
    implemented: true
    working: true
    file: "app/page.js"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Progress bar and % complete text update via direct DOM mutation on requestAnimationFrame (bypassing React). Verified: bar_width tracks scrollTop pixel-perfectly. Persistent save still debounced 400ms."

  - task: "Tap-word Fireworks definition panel"
    implemented: true
    working: true
    file: "app/page.js, app/api/[[...path]]/route.js"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Tap any word -> slide-up panel with definition, phonetic, part of speech, 2 examples + Show more. Uses Fireworks deepseek-v4-flash model. Web Speech API pronounces word and each example."
      - working: true
        agent: "testing"
        comment: "VERIFIED: Tap-word feature still working correctly (regression check passed). Opened Alice's Adventures in Wonderland, clicked word 'her' in text. Definition panel slid up with loading spinner, Fireworks API responded in ~4.7s. Panel displayed word 'Her' with phonetic /hɜːr/, part of speech 'determiner', meaning 'belonging to or connected with a female person or animal already mentioned', and 2 example sentences with audio icons. Feature not broken by BookCard refactor."

metadata:
  created_by: "main_agent"
  version: "1.1"
  test_sequence: 1
  run_ui: true

test_plan:
  current_focus: []
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: |
      User reported hydration errors from BookCard using motion.button with a nested <button> (Remove).
      Two fixes applied:
      1) BookCard now uses motion.div role=button tabIndex=0 with keyboard handler, so nested remove <button> is valid HTML.
      2) Hidden file inputs got suppressHydrationWarning to tolerate browser-extension-injected attributes.
      Please open the app in Chromium, verify NO console hydration errors on load, then verify the "+" button opens the Add Books sheet, and importing a synthetic EPUB (or use /tmp/test-book.epub if available) results in a new book on the shelf under "MY BOOKS" category. Opening the book should show reader with "Chapter 1 of 2" and Next/Previous nav. Also confirm tap-word still opens definition panel (not broken by refactor).
  - agent: "testing"
    message: |
      ✅ ALL BUG FIXES VERIFIED SUCCESSFULLY - ALL 8 TESTS PASSED
      
      Tested on mobile viewport (430x900) at https://cozy-bookshelf-4.preview.emergentagent.com
      
      RESULTS:
      1. ✅ NO hydration/console errors on load - Zero hydration errors, zero button nesting errors
      2. ✅ Bookshelf UI renders correctly - Header, Plus/Bookmark buttons, sections, all books present
      3. ✅ Add Books sheet opens correctly - Proper heading, folder/files options, em-dashes render correctly (no literal \u2014)
      4. ✅ EPUB import works end-to-end - Test book imported, "My Books" section created, toast displayed
      5. ✅ Opening imported book works - Reader shows correct title, chapter info, content, button states
      6. ✅ Chapter navigation works - Next/Previous buttons work, content updates, button states correct
      7. ✅ Tap-word still works - Definition panel opens, Fireworks API responds (~4.7s), displays definition with phonetic and examples
      8. ✅ No console errors during interactions - Zero errors throughout all tests
      
      CONSOLE SUMMARY:
      - Total console messages: 3 (only React DevTools info and preload warnings)
      - Hydration errors: 0
      - Button nesting errors: 0
      - Critical errors: 0
      
      Screenshots captured in .screenshots/ directory showing all features working correctly.
      
      The BookCard nested button bug and file input hydration mismatch are both completely resolved. No regression issues detected.
