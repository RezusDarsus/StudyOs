package com.studyos.assessment;

import java.util.*;
import java.util.regex.*;

/**
 * Deterministic syllabus parsing, hardened against the real world.
 *
 * <p>The original parser only recognised "Week N:" headings, so a Module-based, table-based,
 * date-ranged or non-English syllabus silently produced zero units. This version keeps that
 * contract ({@link #parse(String)} still works) and adds a structured pipeline:
 * {@link #detect(String)} scores syllabus-likeness, {@link #parseDocument(List, String)} parses a
 * chunked document with per-item source grounding, and {@link SyllabusParseConfidence} says how
 * much the deterministic structure was trusted. A syllabus-looking document that yields nothing
 * must never be accepted silently — the service layer turns that state into a structured LLM
 * fallback and otherwise records {@code SYLLABUS_DETECTED_BUT_UNPARSED}.
 */
final class SyllabusParser {
    private static final Pattern WEEK=Pattern.compile("(?im)^\\s*week\\s+(\\d{1,2})\\s*[:.\\-–—]?\\s*([^\\n]*)");
    private static final Pattern ASSESSMENT=Pattern.compile("(?i)\\b(midterm|final(?:\\s+exam)?|exam|quiz|assignment|project|homework|problem\\s+set|test)\\b");
    private static final Pattern ISO_DATE=Pattern.compile("\\b(20\\d{2})[-/](\\d{1,2})[-/](\\d{1,2})\\b");
    private static final Pattern US_DATE=Pattern.compile("\\b(\\d{1,2})/(\\d{1,2})/(20\\d{2})\\b");
    private static final Pattern WEIGHT=Pattern.compile("(\\d+(?:\\.\\d+)?)\\s*%");
    private static final String ASSIGNED_WORDS="assignment|homework|problem set|due";
    /** Unit heading vocabulary: ordinal-led headings in English, Georgian, German and Russian. */
    private static final Pattern HEADING=Pattern.compile("(?imu)^\\s*(?:#+\\s*)?(?:\\d{1,2}[.):]?\\s+)?(week|module|lecture|topic|unit|section|seminar|chapter|part|lesson|კვირა|მოდული|ლექცია|თავი|გაკვეთილი|woche|modul|einheit|kapitel|vorlesung|thema|abschnitt|неделя|модуль|лекция|тема|раздел|глава|урок)\\s+(\\d{1,2}|[ivxlIVXL]{1,6})\\s*[:.\\-–—]?\\s*([^\\n]*)");
    private static final Pattern DATE_RANGE=Pattern.compile("(?im)^\\s*([A-Z][a-z]{2,8}\\s+\\d{1,2})\\s*(?:–|—|-|to)\\s*([A-Z][a-z]{2,8}\\s+\\d{1,2})(?:\\s*,?\\s*(20\\d{2}))?\\s*[:.\\-–—]?\\s*([^\\n]*)");
    private static final Pattern MONTH_DAY=Pattern.compile("([A-Za-z]{3,9})\\s+(\\d{1,2})");
    private static final Pattern PIPE_ROW=Pattern.compile("^\\s*\\|.*\\|\\s*$");
    private static final String MONTHS="january february march april may june july august september october november december jan feb mar apr may jun jul aug sep sept oct nov dec";
    private SyllabusParser(){}

    // ---------------------------------------------------------------- detection

    /** How much a document looks like a syllabus, 0..1, with the signals that produced the score. */
    record Detection(double score, int unitHeadings, int assessmentMentions, int tableRows, int dateMentions, boolean detected) {}

    /**
     * A document counts as a syllabus when it shows sustained course-structure signals: repeated
     * unit headings, assessment announcements, table structure or dates. One stray keyword is not
     * enough; several weak signals together are.
     */
    static Detection detect(String text) {
        if (text == null || text.isBlank()) return new Detection(0, 0, 0, 0, 0, false);
        Matcher headings = HEADING.matcher(text);
        Set<String> distinctOrdinals = new HashSet<>();
        while (headings.find()) distinctOrdinals.add(headings.group(2).toLowerCase(Locale.ROOT));
        int dateRangeHeadings = 0;
        Matcher ranges = DATE_RANGE.matcher(text);
        while (ranges.find()) dateRangeHeadings++;
        int assessmentMentions = 0;
        Matcher assessment = ASSESSMENT.matcher(text);
        while (assessment.find()) assessmentMentions++;
        int tableRows = 0;
        boolean structuredTableHeader = false;
        for (String line : text.split("\\R")) {
            if (!PIPE_ROW.matcher(line).matches()) continue;
            tableRows++;
            if (!structuredTableHeader) {
                String[] columns = pipeColumns(clean(line));
                long named = Arrays.stream(columns).filter(column -> MATCHING_HEADER.matcher(column.toLowerCase(Locale.ROOT)).find()).count();
                if (named >= 2) structuredTableHeader = true;
            }
        }
        int dateMentions = countDates(text);
        double score = Math.min(1, 0.22 * Math.min(distinctOrdinals.size(), 5) + 0.22 * Math.min(dateRangeHeadings, 5) + 0.4 * (structuredTableHeader ? 1 : 0) + 0.05 * Math.min(assessmentMentions, 6) + 0.04 * Math.min(tableRows, 10) + 0.05 * Math.min(dateMentions, 6));
        boolean detected = distinctOrdinals.size() >= 2 || dateRangeHeadings >= 2 || structuredTableHeader || score >= 0.35;
        return new Detection(score, distinctOrdinals.size() + dateRangeHeadings, assessmentMentions, tableRows, dateMentions, detected);
    }

    private static int countDates(String text) {
        int count = 0;
        Matcher iso = ISO_DATE.matcher(text);
        while (iso.find()) count++;
        Matcher us = US_DATE.matcher(text);
        while (us.find()) count++;
        return count;
    }

    // ---------------------------------------------------------------- parsing

    record Unit(int weekNumber,String title,List<String> topics,List<String> learningObjectives,List<String> requiredReadings){}
    record Assessment(String title,String type,java.time.LocalDate date,Double weightPercent){}

    static List<Unit> parse(String text){
        if(text==null||text.isBlank())return List.of();Matcher matcher=WEEK.matcher(text);List<Match> matches=new ArrayList<>();while(matcher.find())matches.add(new Match(matcher.start(),Integer.parseInt(matcher.group(1)),clean(matcher.group(2))));List<Unit> units=new ArrayList<>();
        for(int index=0;index<matches.size();index++){Match current=matches.get(index);int end=index+1<matches.size()?matches.get(index+1).start():text.length();String body=text.substring(current.start(),end);List<String> lines=Arrays.stream(body.split("\\R")).map(SyllabusParser::clean).filter(line->!line.isBlank()&&!line.toLowerCase(Locale.ROOT).startsWith("week ")).toList();List<String> objectives=matching(lines,"objective","outcome","able to");List<String> readings=matching(lines,"reading","chapter","textbook");List<String> topics=lines.stream().filter(line->!objectives.contains(line)&&!readings.contains(line)&&line.length()<=140).limit(12).toList();units.add(new Unit(current.week(),current.title().isBlank()?"Week "+current.week():current.title(),topics,objectives,readings));}
        return List.copyOf(units);
    }

    static List<Assessment> assessments(String text){List<Assessment> result=new ArrayList<>();if(text==null)return List.of();for(String raw:text.split("\\R")){String line=clean(raw);Matcher kind=ASSESSMENT.matcher(line);if(!kind.find())continue;java.time.LocalDate date=date(line);Matcher weight=WEIGHT.matcher(line);Double percent=weight.find()?Double.valueOf(weight.group(1)):null;result.add(new Assessment(line,kind.group(1).toUpperCase(Locale.ROOT).replace(' ','_'),date,percent));}return result.stream().distinct().limit(30).toList();}

    // ------------------------------------------- structured, chunk-grounded parsing

    /** One source chunk, so every parsed item can reference exactly where it came from. */
    record ChunkInput(UUID chunkId, String text) {}

    record ParsedUnit(String title, Integer ordinal, Integer week, java.time.LocalDate date,
                      List<String> topics, List<String> readings, List<String> assignments,
                      List<UUID> sourceChunkIds) {}

    record ParsedAssessment(String title, String type, java.time.LocalDate date, Double weightPercent,
                            List<UUID> sourceChunkIds) {}

    enum ParseConfidence { HIGH, MEDIUM, LOW }

    enum ParseStatus { PARSED, SYLLABUS_DETECTED_BUT_UNPARSED, NOT_SYLLABUS }

    record ParseResult(ParseStatus status, ParseConfidence confidence, Detection detection,
                       List<ParsedUnit> units, List<ParsedAssessment> assessments, List<String> issues) {}

    /**
     * Parses a chunked document. Units are extracted from the joined text (bodies legitimately span
     * chunk boundaries) and then grounded back onto the chunks whose text carries them; a unit whose
     * title and topics appear in no chunk is dropped, never invented.
     */
    static ParseResult parseDocument(List<ChunkInput> chunks, Detection detection) {
        String joined = chunks.stream().map(ChunkInput::text).filter(Objects::nonNull).collect(java.util.stream.Collectors.joining("\n"));
        if (detection == null) detection = detect(joined);
        if (!detection.detected() && detection.score() < 0.15) {
            return new ParseResult(ParseStatus.NOT_SYLLABUS, ParseConfidence.LOW, detection, List.of(), List.of(), List.of());
        }
        List<String> issues = new ArrayList<>();
        List<ParsedUnit> units = new ArrayList<>();
        units.addAll(ordinalUnits(joined, chunks, issues));
        units.addAll(tableUnits(joined, chunks, issues));
        units.addAll(dateRangeUnits(joined, chunks, issues));
        units = dedupeUnits(units, issues);
        List<ParsedAssessment> assessments = groundAssessments(assessments(joined), chunks, issues);

        if (units.isEmpty() && assessments.isEmpty()) {
            // Zero results on a syllabus-looking document is never silently accepted: the service
            // layer reads this status and escalates to the structured LLM fallback.
            ParseStatus status = detection.detected() ? ParseStatus.SYLLABUS_DETECTED_BUT_UNPARSED : ParseStatus.NOT_SYLLABUS;
            return new ParseResult(status, ParseConfidence.LOW, detection, List.of(), List.of(), issues);
        }
        ParseConfidence confidence = confidence(detection, units);
        return new ParseResult(ParseStatus.PARSED, confidence, detection, List.copyOf(units), assessments, issues);
    }

    private static ParseConfidence confidence(Detection detection, List<ParsedUnit> units) {
        boolean deterministicStructure = detection.unitHeadings() >= 3;
        boolean severalUnits = units.size() >= 3;
        if (deterministicStructure && severalUnits) return ParseConfidence.HIGH;
        if (units.size() >= 1 && detection.unitHeadings() >= 1) return ParseConfidence.MEDIUM;
        return ParseConfidence.LOW;
    }

    /** Week/Module/Lecture/Unit/Section-style headings in any supported language, Roman numerals included. */
    private static List<ParsedUnit> ordinalUnits(String text, List<ChunkInput> chunks, List<String> issues) {
        Matcher matcher = HEADING.matcher(text);
        List<int[]> spans = new ArrayList<>();
        List<Integer> ordinals = new ArrayList<>();
        List<Integer> weeks = new ArrayList<>();
        List<String> titles = new ArrayList<>();
        while (matcher.find()) {
            Integer ordinal = ordinal(matcher.group(2));
            if (ordinal == null || ordinal < 1 || ordinal > 99) continue;
            String kind = matcher.group(1).toLowerCase(Locale.ROOT);
            int week = List.of("week", "კვირა", "woche", "неделя").contains(kind) ? ordinal : -1;
            String title = clean(matcher.group(3));
            spans.add(new int[]{matcher.start()});
            ordinals.add(ordinal);
            weeks.add(week);
            titles.add(title.isBlank() ? defaultTitle(kind, ordinal) : title);
        }
        return buildUnits(text, spans, ordinals, weeks, titles, chunks, issues);
    }

    /** Table-shaped syllabi: a header row names the columns, data rows become units. */
    private static List<ParsedUnit> tableUnits(String text, List<ChunkInput> chunks, List<String> issues) {
        List<ParsedUnit> units = new ArrayList<>();
        String[] lines = text.split("\\R");
        int headerIndex = -1;
        String[] header = null;
        for (int index = 0; index < lines.length; index++) {
            String line = clean(lines[index]);
            if (!PIPE_ROW.matcher(lines[index]).matches()) continue;
            String[] columns = pipeColumns(line);
            long named = Arrays.stream(columns).filter(column -> MATCHING_HEADER.matcher(column.toLowerCase(Locale.ROOT)).find()).count();
            if (named >= 2) { headerIndex = index; header = columns; break; }
        }
        if (headerIndex < 0) return units;
        int weekColumn = column(header, "week|kvira|woche|неделя|კვირა");
        int topicColumn = column(header, "topic|theme|thema|тема|content|subject|title");
        int readingColumn = column(header, "reading|chapter|textbook|literature");
        int dateColumn = column(header, "date");
        int assignmentColumn = column(header, "assignment|homework|due");
        for (int index = headerIndex + 1; index < lines.length && index <= headerIndex + 80; index++) {
            String line = clean(lines[index]);
            if (!PIPE_ROW.matcher(lines[index]).matches()) continue;
            String[] columns = pipeColumns(line);
            if (Arrays.stream(columns).allMatch(column -> column.matches("-+|:?-+:?|\\s*"))) continue; // markdown separator
            String topicText = topicColumn >= 0 && topicColumn < columns.length ? columns[topicColumn] : "";
            String title = topicText.isBlank() ? (weekColumn >= 0 && weekColumn < columns.length ? "Week " + columns[weekColumn] : "") : topicText;
            if (title.isBlank()) continue;
            Integer week = weekColumn >= 0 && weekColumn < columns.length ? ordinal(columns[weekColumn]) : null;
            java.time.LocalDate date = dateColumn >= 0 && dateColumn < columns.length ? date(columns[dateColumn]) : null;
            if (week == null && date == null) continue; // a data row with neither week nor date is not a course unit
            List<String> readings = readingColumn >= 0 && readingColumn < columns.length && !columns[readingColumn].isBlank() ? List.of(columns[readingColumn]) : List.of();
            List<String> assignments = assignmentColumn >= 0 && assignmentColumn < columns.length && !columns[assignmentColumn].isBlank() ? List.of(columns[assignmentColumn]) : List.of();
            List<String> topics = topicText.isBlank() ? List.of() : List.of(topicText);
            List<UUID> grounded = ground(title + " " + topicText, chunks);
            if (grounded.isEmpty()) { issues.add("Table row not grounded in any chunk: " + title); continue; }
            units.add(new ParsedUnit(title, week, week, date, topics, readings, assignments, grounded));
        }
        return units;
    }

    private static final Pattern MATCHING_HEADER = Pattern.compile("week|topic|theme|thema|тема|კვირა|date|reading|chapter|assignment|homework|due|content|subject|title|module|unit");

    private static int column(String[] header, String names) {
        Pattern pattern = Pattern.compile(names);
        for (int index = 0; index < header.length; index++) if (pattern.matcher(header[index].toLowerCase(Locale.ROOT)).find()) return index;
        return -1;
    }

    private static String[] pipeColumns(String line) {
        String body = line.replaceAll("^\\s*\\|", "").replaceAll("\\|\\s*$", "");
        return Arrays.stream(body.split("\\|")).map(String::trim).toArray(String[]::new);
    }

    /** "Aug 25 – Sep 1: Introduction" headings, common in US syllabi. */
    private static List<ParsedUnit> dateRangeUnits(String text, List<ChunkInput> chunks, List<String> issues) {
        Matcher matcher = DATE_RANGE.matcher(text);
        List<int[]> spans = new ArrayList<>();
        List<Integer> ordinals = new ArrayList<>();
        List<Integer> weeks = new ArrayList<>();
        List<String> titles = new ArrayList<>();
        int auto = 0;
        while (matcher.find()) {
            java.time.LocalDate start = monthDay(matcher.group(1), matcher.group(3));
            if (start == null) continue;
            auto++;
            spans.add(new int[]{matcher.start()});
            ordinals.add(auto);
            weeks.add(-1);
            titles.add(clean(matcher.group(4)).isBlank() ? "Week of " + matcher.group(1) : clean(matcher.group(4)));
        }
        return buildUnits(text, spans, ordinals, weeks, titles, chunks, issues);
    }

    private static java.time.LocalDate monthDay(String monthDay, String year) {
        Matcher matcher = MONTH_DAY.matcher(monthDay.trim());
        if (!matcher.find()) return null;
        int month = monthIndex(matcher.group(1));
        if (month < 1) return null;
        try {
            int day = Integer.parseInt(matcher.group(2));
            int resolvedYear = year == null ? java.time.Year.now().getValue() : Integer.parseInt(year);
            return java.time.LocalDate.of(resolvedYear, month, day);
        } catch (NumberFormatException | java.time.DateTimeException ignored) {
            return null;
        }
    }

    private static int monthIndex(String name) {
        String[] months = MONTHS.split(" ");
        String lowered = name.toLowerCase(Locale.ROOT);
        for (int index = 0; index < months.length; index++) if (months[index].equals(lowered)) return (index % 12) + 1;
        return -1;
    }

    private static List<ParsedUnit> buildUnits(String text, List<int[]> spans, List<Integer> ordinals, List<Integer> weeks,
                                               List<String> titles, List<ChunkInput> chunks, List<String> issues) {
        List<ParsedUnit> units = new ArrayList<>();
        for (int index = 0; index < spans.size(); index++) {
            int start = spans.get(index)[0];
            int end = index + 1 < spans.size() ? spans.get(index + 1)[0] : text.length();
            String body = text.substring(start, end);
            List<String> lines = Arrays.stream(body.split("\\R")).map(SyllabusParser::clean).filter(line -> !line.isBlank()).toList();
            List<String> objectives = matching(lines, "objective", "outcome", "able to");
            List<String> readings = matching(lines, "reading", "chapter", "textbook");
            List<String> assigned = matching(lines, ASSIGNED_WORDS.split("\\|"));
            List<String> topics = lines.stream()
                    .filter(line -> !objectives.contains(line) && !readings.contains(line) && !assigned.contains(line) && line.length() <= 140)
                    .filter(line -> !isHeadingLine(line))
                    .limit(12)
                    .toList();
            List<UUID> grounded = ground(titles.get(index) + " " + String.join(" ", topics), chunks);
            if (grounded.isEmpty()) { issues.add("Unit not grounded in any chunk: " + titles.get(index)); continue; }
            units.add(new ParsedUnit(titles.get(index), ordinals.get(index), weeks.get(index) > 0 ? weeks.get(index) : null, null,
                    topics, readings, assigned, grounded));
        }
        return units;
    }

    private static boolean isHeadingLine(String line) {
        return HEADING.matcher(line).lookingAt() || DATE_RANGE.matcher(line).lookingAt();
    }

    private static String defaultTitle(String kind, int ordinal) {
        return Character.toUpperCase(kind.charAt(0)) + kind.substring(1) + " " + ordinal;
    }

    /** Maps text onto the chunks that actually contain it; falls back to best token overlap. */
    private static List<UUID> ground(String signature, List<ChunkInput> chunks) {
        String normalized = TopicGrounding.fold(signature);
        if (normalized.isBlank()) return List.of();
        UUID best = null;
        double bestOverlap = 0;
        for (ChunkInput chunk : chunks) {
            String folded = TopicGrounding.fold(chunk.text());
            if (folded.contains(normalized)) return List.of(chunk.chunkId());
            double overlap = TopicGrounding.overlap(normalized, folded);
            if (overlap > bestOverlap) { bestOverlap = overlap; best = chunk.chunkId(); }
        }
        return bestOverlap >= 0.5 && best != null ? List.of(best) : List.of();
    }

    private static List<ParsedAssessment> groundAssessments(List<Assessment> parsed, List<ChunkInput> chunks, List<String> issues) {
        List<ParsedAssessment> result = new ArrayList<>();
        for (Assessment assessment : parsed) {
            List<UUID> grounded = ground(assessment.title(), chunks);
            if (grounded.isEmpty()) { issues.add("Assessment not grounded in any chunk: " + assessment.title()); continue; }
            result.add(new ParsedAssessment(assessment.title(), assessment.type(), assessment.date(), assessment.weightPercent(), grounded));
        }
        return result;
    }

    /** Same concept twice (week heading + table row, deterministic + fallback) keeps the first form. */
    private static List<ParsedUnit> dedupeUnits(List<ParsedUnit> units, List<String> issues) {
        LinkedHashMap<String, ParsedUnit> unique = new LinkedHashMap<>();
        for (ParsedUnit unit : units) {
            String key = (unit.week() != null ? "w" + unit.week() : "") + "|" + TopicGrounding.fold(unit.title());
            ParsedUnit existing = unique.get(key);
            if (existing == null) { unique.put(key, unit); continue; }
            issues.add("Duplicate unit suppressed: " + unit.title());
        }
        return new ArrayList<>(unique.values());
    }

    /** A date, only ever from text that actually contains one — nothing is invented. */
    static java.time.LocalDate date(String line) {
        if (line == null) return null;
        try {
            Matcher iso = ISO_DATE.matcher(line);
            if (iso.find()) return java.time.LocalDate.of(Integer.parseInt(iso.group(1)), Integer.parseInt(iso.group(2)), Integer.parseInt(iso.group(3)));
            Matcher us = US_DATE.matcher(line);
            if (us.find()) return java.time.LocalDate.of(Integer.parseInt(us.group(3)), Integer.parseInt(us.group(1)), Integer.parseInt(us.group(2)));
            Matcher range = MONTH_DAY.matcher(line);
            if (range.find()) {
                int month = monthIndex(range.group(1));
                if (month > 0) return java.time.LocalDate.of(java.time.Year.now().getValue(), month, Integer.parseInt(range.group(2)));
            }
        } catch (NumberFormatException | java.time.DateTimeException ignored) {}
        return null;
    }

    /** Roman numerals and Arabic digits to a sane ordinal; anything else is not a unit number. */
    static Integer ordinal(String value) {
        if (value == null || value.isBlank()) return null;
        String trimmed = value.trim();
        if (trimmed.matches("\\d{1,3}")) return Integer.parseInt(trimmed);
        return roman(trimmed.toUpperCase(Locale.ROOT));
    }

    private static Integer roman(String value) {
        return switch (value) {
            case "I" -> 1; case "II" -> 2; case "III" -> 3; case "IV" -> 4; case "V" -> 5; case "VI" -> 6;
            case "VII" -> 7; case "VIII" -> 8; case "IX" -> 9; case "X" -> 10; case "XI" -> 11; case "XII" -> 12;
            case "XIII" -> 13; case "XIV" -> 14; case "XV" -> 15; case "XVI" -> 16; case "XVII" -> 17; case "XVIII" -> 18;
            case "XIX" -> 19; case "XX" -> 20; case "XL" -> 40; case "L" -> 50;
            default -> null;
        };
    }

    private static List<String> matching(List<String> lines, String... needles) {
        return lines.stream().filter(line -> {
            String lower = line.toLowerCase(Locale.ROOT);
            return Arrays.stream(needles).anyMatch(lower::contains);
        }).limit(10).toList();
    }

    private static String clean(String value) {
        return value == null ? "" : value.replaceAll("^[•*\\-–—]+\\s*", "").replaceAll("\\s+", " ").trim();
    }

    private record Match(int start,int week,String title){}

    /** Fold-for-compare helpers shared by the parser and the LLM grounding validator. */
    static final class TopicGrounding {
        private TopicGrounding() {}

        static String fold(String value) {
            return value == null ? "" : value.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{Nd}]+", " ").trim().replaceAll("\\s+", " ");
        }

        static double overlap(String needle, String haystack) {
            Set<String> tokens = new LinkedHashSet<>(Arrays.asList(needle.split(" ")));
            if (tokens.isEmpty()) return 0;
            long found = tokens.stream().filter(token -> token.length() > 1 && haystack.contains(token)).count();
            return (double) found / tokens.size();
        }
    }
}
