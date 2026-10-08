package com.studyos.ai;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.lang.reflect.Constructor;
import java.lang.reflect.RecordComponent;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Decides, purely from the target DTO's declaration, whether it is a <em>single-list wrapper</em> —
 * a record with exactly one property, that property a collection whose element type is known. That
 * is the only shape the gateway may repair against: a bare array or a bare single object can then
 * be wrapped into the one collection field without guessing any semantics.
 *
 * <p>Anything ambiguous — a non-record, an unresolvable element type, more than one property,
 * more than one collection — is reported as not eligible, and no repair is attempted for it.
 */
final class SingleListWrapperShape {
    private SingleListWrapperShape() {}

    /**
     * @param acceptedNames the collection field's external name plus every alias it deserializes from
     * @param element       the declared element type of the collection field
     * @param elementNames  the element type's external property names; empty when the element is not
     *                      confidently introspectable, which makes wrapping inadmissible
     */
    record Shape(Class<?> type, String field, Set<String> acceptedNames, Class<?> element, Set<String> elementNames) {}

    static Optional<Shape> of(Class<?> type) {
        Map<String, FieldSpec> properties = properties(type);
        if (properties == null || properties.size() != 1) return Optional.empty();
        FieldSpec only = properties.values().iterator().next();
        if (!only.collection || only.element == null) return Optional.empty();
        Set<String> elementNames = propertyNames(only.element);
        if (elementNames == null || elementNames.isEmpty()) return Optional.empty();
        FieldSpec spec = only;
        return Optional.of(new Shape(type, spec.externalName, spec.acceptedNames, only.element, elementNames));
    }

    /**
     * Every external name the target's properties deserialize from — property names plus their
     * aliases — or {@code null} when the type is not confidently introspectable (not a record with
     * a single unambiguous creator). Used to refuse responses that share no property with the
     * target at all, rather than deserializing them into an all-empty object nobody asked for.
     */
    static Set<String> propertyNames(Class<?> type) {
        Map<String, FieldSpec> properties = properties(type);
        if (properties == null) return null;
        Set<String> names = new LinkedHashSet<>();
        for (FieldSpec spec : properties.values()) names.addAll(spec.acceptedNames());
        return names;
    }

    private record FieldSpec(String externalName, Set<String> acceptedNames, boolean collection, Class<?> element) {}

    /**
     * External property names to accepted aliases for one record type, read from its creator
     * parameters; {@code null} when the type is not a record or its creator cannot be identified
     * unambiguously.
     */
    private static Map<String, FieldSpec> properties(Class<?> type) {
        if (type == null || !type.isRecord()) return null;
        RecordComponent[] components = type.getRecordComponents();
        Constructor<?> creator = creatorOf(type, components);
        if (creator == null) return null;
        Class<?>[] parameterTypes = creator.getParameterTypes();
        if (parameterTypes.length != components.length) return null;
        Map<String, FieldSpec> properties = new LinkedHashMap<>();
        java.lang.reflect.Type[] genericTypes = creator.getGenericParameterTypes();
        for (int index = 0; index < parameterTypes.length; index++) {
            RecordComponent component = components[index];
            java.lang.annotation.Annotation[] parameterAnnotations = creator.getParameterAnnotations()[index] == null
                    ? new java.lang.annotation.Annotation[0]
                    : creator.getParameterAnnotations()[index];
            // Provider DTOs annotate either the creator parameter or the record component itself;
            // both are read so an alias written in either place is honoured.
            JsonProperty named = annotation(parameterAnnotations, JsonProperty.class);
            if (named == null) named = component.getAnnotation(JsonProperty.class);
            String externalName = named != null && !named.value().isBlank() ? named.value() : component.getName();
            JsonAlias alias = annotation(parameterAnnotations, JsonAlias.class);
            if (alias == null) alias = component.getAnnotation(JsonAlias.class);
            Set<String> accepted = new LinkedHashSet<>();
            accepted.add(externalName);
            if (alias != null) for (String value : alias.value()) if (!value.isBlank()) accepted.add(value);
            boolean collection = Collection.class.isAssignableFrom(parameterTypes[index]);
            Class<?> element = null;
            if (collection && genericTypes[index] instanceof java.lang.reflect.ParameterizedType parameterized
                    && parameterized.getActualTypeArguments().length == 1
                    && parameterized.getActualTypeArguments()[0] instanceof Class<?> argument) {
                element = argument;
            }
            properties.put(externalName, new FieldSpec(externalName, Set.copyOf(accepted), collection, element));
        }
        return properties;
    }

    /** The {@code @JsonCreator} constructor when there is exactly one, else the canonical constructor. */
    private static Constructor<?> creatorOf(Class<?> type, RecordComponent[] components) {
        Constructor<?> canonical = null;
        int creators = 0;
        for (Constructor<?> candidate : type.getDeclaredConstructors()) {
            if (candidate.getAnnotation(JsonCreator.class) != null) creators++;
            Class<?>[] parameterTypes = candidate.getParameterTypes();
            if (parameterTypes.length == components.length) {
                boolean matches = true;
                for (int index = 0; index < parameterTypes.length; index++)
                    if (!parameterTypes[index].equals(components[index].getType())) { matches = false; break; }
                if (matches) canonical = candidate;
            }
        }
        if (creators == 1) {
            for (Constructor<?> candidate : type.getDeclaredConstructors())
                if (candidate.getAnnotation(JsonCreator.class) != null) return candidate;
        }
        return creators == 0 ? canonical : null;
    }

    private static <A extends java.lang.annotation.Annotation> A annotation(java.lang.annotation.Annotation[] annotations, Class<A> type) {
        for (java.lang.annotation.Annotation candidate : annotations) if (type.isInstance(candidate)) return type.cast(candidate);
        return null;
    }
}
